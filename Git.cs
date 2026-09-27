using System.Diagnostics;
using System.Text;

namespace WorkflowRunner;

public class Git(Repo repo)
{
    public record Result(int Exit, string Out, string Err)
    {
        public bool Ok => Exit == 0;
        public string Text => (Out + "\n" + Err).Trim();
    }

    // Git in ra mọi lệnh đã chạy, Runner nối vào log
    public Action<string> OnLine { get; set; } = _ => { };

    public async Task<bool> HasChangesAsync(string folder) =>
        (await Must("status", "--porcelain", "--", folder + "/")).Out.Trim().Length > 0;

    public async Task<string> CommitAsync(string folder, string message)
    {
        await Must("add", "-A", "--", folder + "/");
        await Must("commit", "-m", message, "--", folder + "/");   // "-- folder/": chỉ commit đúng folder này
        return (await Must("rev-parse", "HEAD")).Out.Trim();
    }

    public async Task RestoreAsync(string folder)
    {
        // restore báo lỗi nếu folder không có file nào đang được track; khi đó chỉ cần clean
        if ((await RunAsync("ls-files", "--", folder + "/")).Out.Trim().Length > 0)
            await Must("restore", "--staged", "--worktree", "--", folder + "/");
        await Must("clean", "-fd", "--", folder + "/");
    }

    public async Task<bool> IsCleanAsync() => (await Must("status", "--porcelain")).Out.Trim().Length == 0;

    public async Task<bool> IsPushedAsync(string sha) => (await Must("branch", "-r", "--contains", sha)).Out.Trim().Length > 0;

    public async Task<bool> IsRebasingAsync()
    {
        var dir = (await Must("rev-parse", "--git-path", "rebase-merge")).Out.Trim();
        return Directory.Exists(Path.IsPathRooted(dir) ? dir : Path.Combine(repo.Root, dir));
    }

    public async Task<string?> ParentAsync(string sha)
    {
        var r = await RunAsync("rev-parse", "--verify", "--quiet", sha + "~1");
        return r.Ok ? r.Out.Trim() : null;
    }

    public async Task<List<string>> RevListAsync(string? baseSha)
    {
        var r = baseSha == null ? await Must("rev-list", "--reverse", "HEAD")
                                : await Must("rev-list", "--reverse", baseSha + "..HEAD");
        return r.Out.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();
    }

    public async Task<string> SubjectAsync(string sha) => (await Must("log", "-1", "--format=%B", sha)).Out.Trim();

    // Dừng rebase ở commit sha (exe này làm GIT_SEQUENCE_EDITOR đổi pick → edit) rồi bỏ commit, giữ thay đổi ở stage
    public async Task AmendStartAsync(string sha, string? parent)
    {
        var exe = (Environment.ProcessPath ?? throw new InvalidOperationException("Không biết đường dẫn exe")).Replace('\\', '/');
        var env = new Dictionary<string, string> { ["GIT_SEQUENCE_EDITOR"] = $"\"{exe}\" --mark-edit {sha}" };
        var r = await RunAsync(env, "rebase", "-i", parent ?? "--root");
        if (!r.Ok || !await IsRebasingAsync())
        {
            if (await IsRebasingAsync()) await RunAsync("rebase", "--abort");
            throw new InvalidOperationException("git rebase thất bại:\n" + r.Text);
        }
        await Must("reset", "--soft", "HEAD~1");
    }

    // Trả về true nếu rebase dừng vì conflict
    public async Task<bool> AmendFinishAsync(string folder, string message, bool resolvingConflict)
    {
        if (resolvingConflict)
            await Must("add", "-u");                       // file conflict dev vừa gỡ
        else
        {
            await Must("add", "-A", "--", folder + "/");
            await Must("commit", "--allow-empty", "-m", message);   // allow-empty: giữ đúng số commit để gán lại sha
        }
        var r = await RunAsync("rebase", "--continue");
        if (r.Ok) return false;
        if (await IsRebasingAsync()) return true;
        throw new InvalidOperationException("git rebase --continue thất bại:\n" + r.Text);
    }

    public Task AbortAsync() => Must("rebase", "--abort");

    async Task<Result> Must(params string[] args)
    {
        var r = await RunAsync(args);
        if (!r.Ok) throw new InvalidOperationException($"git {string.Join(' ', args)} lỗi:\n{r.Text}");
        return r;
    }

    Task<Result> RunAsync(params string[] args) => RunAsync(new Dictionary<string, string>(), args);

    async Task<Result> RunAsync(Dictionary<string, string> env, params string[] args)
    {
        var psi = new ProcessStartInfo("git") {
            WorkingDirectory = repo.Root,
            RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
            UseShellExecute = false, CreateNoWindow = true };
        psi.ArgumentList.Add("-c"); psi.ArgumentList.Add("core.quotepath=false");   // tên file tiếng Việt không bị \303\241
        foreach (var a in args) psi.ArgumentList.Add(a);
        psi.Environment["GIT_TERMINAL_PROMPT"] = "0";                                // không bao giờ hỏi mật khẩu
        psi.Environment["GIT_EDITOR"] = "true";                                      // không bao giờ mở editor
        foreach (var (k, v) in env) psi.Environment[k] = v;

        using var p = Process.Start(psi)!;
        var stdout = p.StandardOutput.ReadToEndAsync();
        var stderr = p.StandardError.ReadToEndAsync();
        await p.WaitForExitAsync();
        var r = new Result(p.ExitCode, await stdout, await stderr);
        if (args[0] is "add" or "commit" or "restore" or "clean" or "rebase" or "reset")
            OnLine($"$ git {string.Join(' ', args)}" + (r.Ok ? "" : $"  → lỗi {r.Exit}: {r.Err.Trim()}"));
        return r;
    }
}
