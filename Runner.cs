using System.Text.Json;

namespace WorkflowRunner;

public class Runner
{
    readonly SemaphoreSlim _lock = new(1, 1);   // tại một thời điểm chỉ một thao tác chạm vào repo
    readonly object _sync = new();              // giữ State nhất quán khi UI đọc giữa lúc đang chạy nền
    readonly WorkflowStore store;
    readonly StateStore stateStore;
    readonly Shell shell;
    readonly Git git;

    public RunState State { get; }
    public string? Error { get; private set; }   // lỗi của thao tác chạy nền gần nhất
    WorkflowDef? _wfBeforeAmend;                 // khi rebase dừng ở commit cũ, YAML trên đĩa cũng là bản cũ

    public Runner(Repo repo, WorkflowStore store, StateStore stateStore, Shell shell, Git git)
    {
        (this.store, this.stateStore, this.shell, this.git) = (store, stateStore, shell, git);
        State = stateStore.Load(repo.Root);
        git.OnLine = AddLog;
    }

    // Tắt tool giữa lúc sửa commit cũ: mở lại thì vào thẳng màn sửa commit
    public async Task InitAsync()
    {
        var rebasing = await git.IsRebasingAsync();
        if (rebasing && State.Amend == null)
        {
            State.Amend = new AmendState("", "", "", Conflict: true, "", new());
            AddLog("Repo đang dở một git rebase: gỡ conflict (nếu có) rồi Hoàn tất, hoặc Hủy.");
        }
        else if (!rebasing && State.Amend != null)
        {
            State.Amend = null;
            AddLog("Rebase đã được xử lý bên ngoài tool, bỏ trạng thái sửa commit.");
        }
        Save();
    }

    // ===== Bắt đầu / bỏ lần chạy =====

    public Task StartRunAsync(string workflowId) => Locked(() =>
    {
        NotAmending();
        if (State.InProgress) throw new InvalidOperationException("Đang có lần chạy dở; bỏ lần chạy đó trước");
        var wf = store.Load(workflowId);
        if (wf.Steps.Count == 0) throw new InvalidOperationException("Workflow chưa có step nào");
        if (wf.Folders.Count == 0) throw new InvalidOperationException("Workflow chưa có folder nào");
        lock (_sync)
        {
            State.Paused = false;
            State.WorkflowFile = workflowId;
            State.Steps = wf.Steps.ToDictionary(s => s.Id, _ => new StepRun());
            State.CurrentStepId = wf.Steps[0].Id;
        }
        Error = null;
        AddLog($"=== Bắt đầu workflow '{wf.Name}' ===");
        return Task.CompletedTask;
    });

    // Chỉ quên trạng thái; không đụng vào git
    public Task ResetAsync() => Locked(() =>
    {
        NotAmending();
        lock (_sync)
        {
            State.Paused = false;
            State.WorkflowFile = "";
            State.Steps = new();
            State.CurrentStepId = null;
        }
        Error = null;
        AddLog("=== Đã bỏ lần chạy ===");
        return Task.CompletedTask;
    });

    // ===== Chạy step =====

    public Task RunStepAsync(string stepId) => Background(
        validate: () =>
        {
            var (_, _, run) = Current(stepId);
            if (run.Status != StepStatus.Pending) throw new InvalidOperationException("Step đã chạy; dùng Chạy lại theo từng folder");
        },
        work: async () =>
        {
            var (wf, step, _) = Current(stepId);
            await RunStepCore(wf, step);
        });

    public Task RunUntilAsync(string targetId) => Background(
        validate: () =>
        {
            var (wf, _, run) = Current(State.CurrentStepId ?? "");
            if (run.Status != StepStatus.Pending) throw new InvalidOperationException("Step hiện tại đã chạy; xử lý xong rồi sang step kế trước");
            if (IndexOf(wf, targetId) < IndexOf(wf, State.CurrentStepId!)) throw new InvalidOperationException("Step đích nằm trước step hiện tại");
        },
        work: async () =>
        {
            while (State.CurrentStepId != null)
            {
                var (wf, step, _) = Current(State.CurrentStepId);
                var run = await RunStepCore(wf, step);
                if (run.Status == StepStatus.WaitingManual) { AddLog($"Dừng ở step Sửa tay '{step.Name}'"); return; }
                if (run.Folders.Any(f => f.Result == FolderResult.Fail)) { AddLog($"Dừng ở '{step.Name}': có folder Fail"); return; }

                foreach (var f in run.Folders.Where(f => f.Result == FolderResult.Pass))
                    await CommitCore(f, f.CommitMessage);
                run.Auto = true;
                AddLog($"Step '{step.Name}' pass 100% → tự commit {run.Folders.Count(f => f.CommitSha != null)} folder");
                Advance(wf, run, StepStatus.Done);
                if (step.Id == targetId) return;
            }
        });

    async Task<StepRun> RunStepCore(WorkflowDef wf, StepDef step)
    {
        var run = new StepRun();
        lock (_sync) State.Steps[step.Id] = run;
        AddLog($"--- Step '{step.Name}' ---");

        if (step.Kind == "manual") { run.Status = StepStatus.WaitingManual; return run; }

        foreach (var folder in step.Folders ?? wf.Folders)            // tuần tự, xong folder này mới sang folder kế
        {
            var fr = new FolderRun { Folder = folder, CommitMessage = CommitMessage.Build(step, wf.Defaults, folder) };
            await RunFolder(wf, step, fr);                               // fail vẫn chạy tiếp folder sau
            lock (_sync) run.Folders.Add(fr);
            Save();
        }
        run.Status = StepStatus.Review;                                  // luôn dừng chờ review
        return run;
    }

    async Task RunFolder(WorkflowDef wf, StepDef step, FolderRun fr)
    {
        var last = "";
        if (step.Kind != "manual") (fr.ExitCode, last) = await shell.RunAsync(step, fr.Folder, State.RepoRoot, wf.Defaults, AddLog);
        var changed = fr.ExitCode == 0 ? await git.ChangeCountAsync(fr.Folder) : 0;
        fr.Result = fr.ExitCode != 0 ? FolderResult.Fail
                  : changed > 0 ? FolderResult.Pass
                  : FolderResult.NoChange;                                // exit 0 nhưng không đổi gì
        // Tóm tắt cạnh tên folder: dòng output cuối + exit code (step sửa tay: số file đổi)
        fr.Summary = step.Kind == "manual"
            ? (changed > 0 ? $"{changed} file thay đổi" : "không có thay đổi")
            : last.StartsWith("timeout") ? last
            : last == "" ? $"exit {fr.ExitCode}" : $"{Short(last)} · exit {fr.ExitCode}";
        AddLog($"[{fr.Folder}] {fr.Result}");
    }

    public Task RerunFolderAsync(string stepId, string folder) => Background(
        validate: () => ReviewFolder(stepId, folder),
        work: async () =>
        {
            var (wf, step, _) = Current(stepId);
            await RunFolder(wf, step, ReviewFolder(stepId, folder));
        });

    public Task ManualDoneAsync(string stepId) => Locked(async () =>
    {
        var (wf, step, run) = Current(stepId);
        if (run.Status != StepStatus.WaitingManual) throw new InvalidOperationException("Step không ở trạng thái chờ sửa tay");
        foreach (var folder in step.Folders ?? wf.Folders)
        {
            var fr = new FolderRun { Folder = folder, CommitMessage = CommitMessage.Build(step, wf.Defaults, folder) };
            await RunFolder(wf, step, fr);
            lock (_sync) run.Folders.Add(fr);
        }
        run.Status = StepStatus.Review;
    });

    // ===== Review từng folder =====

    public Task CommitAsync(string stepId, string folder, string message) => Locked(async () =>
    {
        var fr = ReviewFolder(stepId, folder);
        if (fr.Result != FolderResult.Pass) throw new InvalidOperationException("Chỉ commit được folder Pass");
        if (string.IsNullOrWhiteSpace(message)) throw new InvalidOperationException("Commit message trống");
        await CommitCore(fr, message.Trim());
    });

    async Task CommitCore(FolderRun fr, string message)
    {
        if (!await git.HasChangesAsync(fr.Folder)) throw new InvalidOperationException($"[{fr.Folder}] không còn thay đổi để commit");
        var sha = await git.CommitAsync(fr.Folder, message);
        fr.CommitMessage = message;
        fr.CommitSha = sha;
        AddLog($"[{fr.Folder}] commit {sha[..7]} {message}");
    }

    public Task CommitAllAsync(string stepId, Dictionary<string, string>? messages) => Locked(async () =>
    {
        var (_, _, run) = Current(stepId);
        if (run.Status != StepStatus.Review) throw new InvalidOperationException("Step không ở trạng thái review");
        foreach (var fr in run.Folders.Where(f => f.Result == FolderResult.Pass && !f.Handled))
        {
            var msg = messages != null && messages.TryGetValue(fr.Folder, out var m) && !string.IsNullOrWhiteSpace(m) ? m.Trim() : fr.CommitMessage;
            await CommitCore(fr, msg);
        }
    });

    public Task PauseAsync(bool paused) => Locked(() =>
    {
        if (!State.InProgress) throw new InvalidOperationException("Chưa bắt đầu lần chạy nào");
        State.Paused = paused;
        AddLog(paused ? "Tạm dừng workflow" : "Tiếp tục workflow");
        return Task.CompletedTask;
    });

    public Task RestoreAsync(string stepId, string folder) => Locked(async () =>
    {
        var fr = ReviewFolder(stepId, folder);
        await git.RestoreAsync(folder);   // lỗi (vd. IDE giữ file) đi thẳng lên UI, bấm lại được
        fr.Restored = true;
        AddLog($"[{folder}] đã restore");
    });

    // Cổng review: restore ở step sau sẽ xóa luôn thay đổi chưa commit của step trước
    public Task NextAsync() => Locked(() =>
    {
        var (wf, _, run) = Current(State.CurrentStepId ?? "");
        if (run.Status != StepStatus.Review) throw new InvalidOperationException("Step hiện tại chưa chạy xong");
        if (!run.Folders.All(f => f.Handled))
            throw new InvalidOperationException("Còn folder chưa commit hoặc restore");
        Advance(wf, run, StepStatus.Done);
        return Task.CompletedTask;
    });

    public Task SkipAsync(string stepId) => Locked(() =>
    {
        var (wf, _, run) = Current(stepId);
        if (run.Status != StepStatus.Pending) throw new InvalidOperationException("Chỉ bỏ qua được step chưa chạy");
        Advance(wf, run, StepStatus.Skipped);
        return Task.CompletedTask;
    });

    void Advance(WorkflowDef wf, StepRun run, StepStatus status)
    {
        run.Status = status;
        var next = wf.Steps.SkipWhile(s => s.Id != State.CurrentStepId).Skip(1).FirstOrDefault();
        State.CurrentStepId = next?.Id;
        AddLog(next == null ? "=== Workflow đã chạy xong ===" : $"Sang step '{next.Name}'");
    }

    // ===== Sửa lại commit cũ =====

    // Màn xác nhận trước khi sửa: thông tin commit, số commit phía sau và điều kiện
    public async Task<object> AmendPreviewAsync(string sha)
    {
        var (stepId, fr) = FindCommit(sha);
        var parent = await git.ParentAsync(sha);
        var later = (await git.RevListAsync(parent)).SkipWhile(x => x != sha).Skip(1).ToList();
        var laterSteps = later.Select(x => AllCommits().FirstOrDefault(c => c.Fr.CommitSha == x).StepId)
                              .OfType<string>().Distinct().ToList();
        return new
        {
            Sha = sha, StepId = stepId, fr.Folder, Message = fr.CommitMessage,
            Later = later.Count, LaterSteps = laterSteps,
            Files = await git.FilesOfCommitAsync(sha),
            Clean = await git.IsCleanAsync(), Pushed = await git.IsPushedAsync(sha),
        };
    }

    public Task AmendStartAsync(string sha) => Locked(async () =>
    {
        NotAmending();
        var (_, fr) = FindCommit(sha);
        if (!await git.IsCleanAsync()) throw new InvalidOperationException("Working tree đang có thay đổi; commit hoặc restore trước");
        if (await git.IsPushedAsync(sha)) throw new InvalidOperationException("Commit đã push lên remote, không sửa được");

        var parent = await git.ParentAsync(sha);
        var old = await git.RevListAsync(parent);
        if (!old.Contains(sha)) throw new InvalidOperationException("Commit không nằm trên nhánh hiện tại");

        _wfBeforeAmend = State.WorkflowFile != "" ? store.Load(State.WorkflowFile) : null;
        await git.AmendStartAsync(sha, parent);
        State.Amend = new AmendState(sha, fr.Folder, fr.CommitMessage, Conflict: false, parent ?? "", old);
        AddLog($"Đang sửa commit {sha[..7]} [{fr.Folder}]: sửa file trong folder rồi bấm Hoàn tất");
    });

    public record AmendResult(bool Conflict, string? NewSha, int Later);

    public async Task<AmendResult> AmendFinishAsync(string? message)
    {
        AmendResult result = new(false, null, 0);
        await Locked(async () => result = await AmendFinishCore(message));
        return result;
    }

    async Task<AmendResult> AmendFinishCore(string? message)
    {
        var a = State.Amend ?? throw new InvalidOperationException("Không có commit nào đang sửa");
        var msg = string.IsNullOrWhiteSpace(message) ? a.Message : message.Trim();
        if (await git.AmendFinishAsync(a.Folder, msg, resolvingConflict: a.Conflict || a.Sha == ""))
        {
            State.Amend = a with { Conflict = true, Message = msg };
            AddLog("Conflict khi áp lại các commit phía sau: gỡ conflict rồi Tiếp tục, hoặc Hủy toàn bộ");
            return new AmendResult(true, null, 0);
        }

        string? newSha = null;
        if (a.Sha != "")
        {
            // Sau rebase sha của commit này và các commit phía sau đều đổi: gán lại theo đúng thứ tự
            var now = await git.RevListAsync(a.Base == "" ? null : a.Base);
            if (now.Count == a.OldShas.Count)
            {
                var map = a.OldShas.Zip(now).ToDictionary(p => p.First, p => p.Second);
                foreach (var f in AllFolderRuns().Where(f => f.CommitSha != null && map.ContainsKey(f.CommitSha)))
                {
                    if (f.CommitSha == a.Sha) { f.CommitMessage = msg; f.Amended = true; }
                    f.CommitSha = map[f.CommitSha!];
                }
                newSha = map[a.Sha];
            }
            else AddLog($"Cảnh báo: số commit sau rebase ({now.Count}) khác trước ({a.OldShas.Count}), không gán lại được sha");
        }
        State.Amend = null;
        AddLog(newSha == null ? "Đã áp lại xong các commit" : $"Đã sửa xong commit: {a.Sha[..7]} → {newSha[..7]}");
        return new AmendResult(false, newSha, Math.Max(a.OldShas.Count - 1, 0));
    }

    public Task AmendAbortAsync() => Locked(async () =>
    {
        if (State.Amend == null) throw new InvalidOperationException("Không có commit nào đang sửa");
        await git.AbortAsync();
        State.Amend = null;
        AddLog("Đã hủy sửa commit, mọi thứ về như cũ");
    });

    // ===== Trạng thái cho UI =====

    public async Task<string> SnapshotAsync(int logFrom)
    {
        WorkflowDef? wf = null; string? wfError = null;
        if (State.WorkflowFile != "")
        {
            if (State.Amend != null && _wfBeforeAmend != null) wf = _wfBeforeAmend;
            else try { wf = store.Load(State.WorkflowFile); } catch (InvalidOperationException e) { wfError = e.Message; }
        }

        // Đang sửa commit: file đang staged / đang conflict (bỏ qua khi repo đang bận thao tác khác)
        List<string>? amendFiles = null, conflicts = null;
        if (State.Amend != null && _lock.CurrentCount > 0)
            try { amendFiles = await git.StagedAsync(); conflicts = await git.ConflictsAsync(); }
            catch (InvalidOperationException) { }
        var workflows = store.ListNamed().Select(w => new { w.Id, w.Name }).ToList();

        lock (_sync)
        {
            var first = State.LogTotal - State.Log.Count;          // số thứ tự của dòng cũ nhất còn giữ
            var from = logFrom > State.LogTotal ? first : Math.Max(logFrom, first);
            return JsonSerializer.Serialize(new
            {
                State.RepoRoot, StateFile = StateStore.FilePath,
                Workflows = workflows, AmendFiles = amendFiles, Conflicts = conflicts, State.Paused,
                WorkflowId = State.WorkflowFile, Workflow = wf, WorkflowError = wfError,
                State.CurrentStepId, State.InProgress, State.Steps, State.Amend,
                Busy = _lock.CurrentCount == 0, Error,
                LogFrom = from, Log = State.Log.Skip(from - first).ToList(), State.LogTotal,
            }, StateStore.Json);
        }
    }

    // ===== Tiện ích =====

    (WorkflowDef Wf, StepDef Step, StepRun Run) Current(string stepId)
    {
        NotAmending();
        if (!State.InProgress) throw new InvalidOperationException("Chưa bắt đầu lần chạy nào");
        if (State.Paused) throw new InvalidOperationException("Workflow đang tạm dừng: bấm Tiếp tục trước");
        if (stepId != State.CurrentStepId) throw new InvalidOperationException("Chỉ thao tác được trên step hiện tại");
        var wf = store.Load(State.WorkflowFile);
        var step = wf.Steps.SingleOrDefault(s => s.Id == stepId)
                   ?? throw new InvalidOperationException($"Workflow không còn step '{stepId}'");
        if (!State.Steps.TryGetValue(stepId, out var run)) lock (_sync) State.Steps[stepId] = run = new StepRun();
        return (wf, step, run);
    }

    FolderRun ReviewFolder(string stepId, string folder)
    {
        var (_, _, run) = Current(stepId);
        if (run.Status != StepStatus.Review) throw new InvalidOperationException("Step không ở trạng thái review");
        var fr = run.Folders.SingleOrDefault(f => f.Folder == folder)
                 ?? throw new InvalidOperationException($"Step không chạy trên folder '{folder}'");
        if (fr.CommitSha != null) throw new InvalidOperationException($"[{folder}] đã commit");
        if (fr.Restored) throw new InvalidOperationException($"[{folder}] đã restore");
        return fr;
    }

    IEnumerable<FolderRun> AllFolderRuns() => State.Steps.Values.SelectMany(s => s.Folders);

    IEnumerable<(string StepId, FolderRun Fr)> AllCommits() =>
        State.Steps.SelectMany(kv => kv.Value.Folders.Where(f => f.CommitSha != null).Select(f => (kv.Key, f)));

    (string StepId, FolderRun Fr) FindCommit(string sha)
    {
        foreach (var c in AllCommits()) if (c.Fr.CommitSha == sha) return c;
        throw new InvalidOperationException("Không phải commit do lần chạy này tạo");
    }

    static string Short(string s) => s.Length <= 60 ? s : s[..57] + "…";

    static int IndexOf(WorkflowDef wf, string stepId) =>
        wf.Steps.FindIndex(s => s.Id == stepId) is var i and >= 0 ? i : throw new InvalidOperationException($"Không có step '{stepId}'");

    void NotAmending()
    {
        if (State.Amend != null) throw new InvalidOperationException("Đang sửa commit cũ: Hoàn tất hoặc Hủy trước");
    }

    void AddLog(string line)
    {
        lock (_sync)
        {
            State.Log.Add($"{DateTime.Now:HH:mm:ss} {line}");
            State.LogTotal++;
            if (State.Log.Count > 500) State.Log.RemoveRange(0, State.Log.Count - 500);
        }
    }

    void Save() { lock (_sync) stateStore.Save(State); }

    // Thao tác ngắn: chạy xong mới trả về; đang có thao tác khác thì báo bận thay vì xếp hàng
    async Task Locked(Func<Task> action)
    {
        if (!_lock.Wait(0)) throw new InvalidOperationException("Đang bận, chờ thao tác trước xong");
        try { await action(); }
        finally { Save(); _lock.Release(); }
    }

    // Thao tác lâu: kiểm tra điều kiện ngay (lỗi → 409), phần việc chạy nền, UI theo dõi qua GET /api/run
    Task Background(Action validate, Func<Task> work)
    {
        if (!_lock.Wait(0)) throw new InvalidOperationException("Đang bận, chờ thao tác trước xong");
        try { validate(); }
        catch { Save(); _lock.Release(); throw; }

        Error = null;
        _ = Task.Run(async () =>
        {
            try { await work(); }
            catch (Exception e) { Error = e.Message; AddLog("LỖI: " + e.Message); }
            finally { Save(); _lock.Release(); }
        });
        return Task.CompletedTask;
    }
}
