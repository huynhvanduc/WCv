namespace WorkflowRunner;

// ===== Định nghĩa: map thẳng từ YAML =====
// Dùng class có setter (không phải record positional) vì YamlDotNet cần constructor rỗng.
public class WorkflowDef
{
    public int Version { get; set; } = 1;
    public string Name { get; set; } = "";
    public List<string> Folders { get; set; } = new();
    public Defaults Defaults { get; set; } = new();
    public List<StepDef> Steps { get; set; } = new();
}

public class Defaults
{
    public int TimeoutSeconds { get; set; } = 300;
    public string CommitPattern { get; set; } = "[{folder}]: {message}";
    public string PsHost { get; set; } = "pwsh";                      // pwsh | powershell.exe
}

public class StepDef
{
    public string Id { get; set; } = "";                              // khóa ổn định, không đổi khi đổi tên / kéo thả
    public string Name { get; set; } = "";
    public string Kind { get; set; } = "app";                         // "app" | "manual"
    public string? Shell { get; set; }                                // "cmd" | "powershell"
    public string? PsHost { get; set; }                               // null = theo defaults.psHost
    public string? App { get; set; }
    public List<string>? Args { get; set; }
    public string? Guide { get; set; }
    public string Message { get; set; } = "";
    public List<string>? Folders { get; set; }                        // null = tất cả
    public int? TimeoutSeconds { get; set; }
    public string? CommitPattern { get; set; }
}

// ===== Trạng thái chạy: ghi ra state.json =====
public enum StepStatus { Pending, WaitingManual, Review, Done, Skipped }
public enum FolderResult { Pass, Fail, NoChange }

public class RunState
{
    public string RepoRoot { get; set; } = "";
    public string WorkflowFile { get; set; } = "";                    // id workflow = tên file không đuôi; "" = chưa bắt đầu
    public string? CurrentStepId { get; set; }                        // null + WorkflowFile != "" = đã chạy xong
    public Dictionary<string, StepRun> Steps { get; set; } = new();   // key = StepDef.Id, không phải vị trí
    public AmendState? Amend { get; set; }                            // != null khi đang sửa commit cũ
    public List<string> Log { get; set; } = new();                    // giữ ~500 dòng cuối cho UI
    public int LogTotal { get; set; }                                 // tổng số dòng đã ghi, để UI hỏi "từ dòng N"
    public bool Paused { get; set; }                                  // "Dừng workflow": khóa thao tác tới khi Tiếp tục

    public bool InProgress => WorkflowFile != "" && CurrentStepId != null;
}

public class StepRun
{
    public StepStatus Status { get; set; }
    public bool Auto { get; set; }                                    // chạy liên tiếp pass 100% → tool tự commit
    public List<FolderRun> Folders { get; set; } = new();
}

public class FolderRun
{
    public string Folder { get; set; } = "";
    public FolderResult Result { get; set; }
    public int ExitCode { get; set; }
    public string Summary { get; set; } = "";   // dòng output cuối, hiện cạnh tên folder
    public string CommitMessage { get; set; } = "";
    public string? CommitSha { get; set; }      // sha đầy đủ; null = chưa commit
    public bool Restored { get; set; }
    public bool Amended { get; set; }           // đã sửa lại qua luồng sửa commit cũ
    // Đã xử lý xong = đã commit, đã restore, hoặc không có gì để xử lý
    public bool Handled => CommitSha != null || Restored || Result == FolderResult.NoChange;
}

// Base = cha của commit đang sửa (không đổi sau rebase); OldShas = các commit từ Sha tới HEAD trước khi rebase
public record AmendState(string Sha, string Folder, string Message, bool Conflict, string Base, List<string> OldShas);

public static class CommitMessage
{
    public static string Build(StepDef step, Defaults defaults, string folder) =>
        Build(step.CommitPattern ?? defaults.CommitPattern, folder, step.Message, step.Name);

    public static string Build(string pattern, string folder, string message, string stepName) =>
        pattern.Replace("{folder}", folder).Replace("{message}", message).Replace("{step}", stepName);
}
