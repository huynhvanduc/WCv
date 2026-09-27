using System.Text.Json;
using System.Text.Json.Serialization;

namespace WorkflowRunner;

public class StateStore
{
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        Converters = { new JsonStringEnumConverter() },
    };

    // Ngoài repo: nằm trong repo thì chính file này làm git status bẩn
    public static string FilePath { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WorkflowRunner", "state.json");

    public RunState Load(string repoRoot)
    {
        try
        {
            if (File.Exists(FilePath))
            {
                var s = JsonSerializer.Deserialize<RunState>(File.ReadAllText(FilePath), Json);
                if (s != null && string.Equals(s.RepoRoot, repoRoot, StringComparison.OrdinalIgnoreCase)) return s;
            }
        }
        catch (JsonException) { /* file hỏng: bắt đầu lại từ trạng thái trống */ }
        return new RunState { RepoRoot = repoRoot };
    }

    public void Save(RunState state)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
        var tmp = FilePath + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(state, Json));
        File.Move(tmp, FilePath, overwrite: true);   // ghi qua file tạm để tắt ngang không làm hỏng state
    }
}
