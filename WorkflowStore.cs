using System.Text.RegularExpressions;
using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;

namespace WorkflowRunner;

public record Repo(string Root);

public class WorkflowStore(Repo repo)
{
    static readonly IDeserializer Reader = new DeserializerBuilder()
        .WithNamingConvention(CamelCaseNamingConvention.Instance)
        .Build();

    static readonly ISerializer Writer = new SerializerBuilder()
        .WithNamingConvention(CamelCaseNamingConvention.Instance)
        .ConfigureDefaultValuesHandling(DefaultValuesHandling.OmitNull)
        .Build();

    static readonly Regex IdPattern = new(@"^[A-Za-z0-9][A-Za-z0-9._-]*$");

    public string Dir => Path.Combine(repo.Root, ".workflow-runner", "workflows");

    public List<string> List() =>
        Directory.Exists(Dir)
            ? Directory.GetFiles(Dir, "*.yml").Select(Path.GetFileNameWithoutExtension).OfType<string>().Order().ToList()
            : new();

    // Id kèm tên hiển thị cho danh sách workflow; file hỏng vẫn hiện (theo id) để còn mở ra sửa
    public List<(string Id, string Name)> ListNamed() =>
        List().Select(id => { try { var n = Read(id).Wf.Name; return (id, n == "" ? id : n); } catch { return (id, id); } }).ToList();

    public WorkflowDef Load(string id)
    {
        var (wf, errors) = Read(id);
        if (errors.Count > 0) throw new InvalidOperationException("Workflow không hợp lệ:\n- " + string.Join("\n- ", errors));
        return wf;
    }

    // Đọc kèm danh sách lỗi, không ném: màn Thiết lập vẫn mở được file sai để sửa
    public (WorkflowDef Wf, List<string> Errors) Read(string id)
    {
        var path = PathOf(id);
        if (!File.Exists(path)) throw new InvalidOperationException($"Không thấy workflow '{id}'");
        WorkflowDef wf;
        try { wf = Reader.Deserialize<WorkflowDef>(File.ReadAllText(path)) ?? new(); }
        catch (YamlDotNet.Core.YamlException e)
        {
            return (new WorkflowDef(), [$"YAML lỗi ở {e.Start}: {e.InnerException?.Message ?? e.Message}"]);
        }
        return (wf, Validate(wf));
    }

    public void Save(string id, WorkflowDef wf)
    {
        var errors = Validate(wf);
        if (errors.Count > 0) throw new InvalidOperationException("Workflow không hợp lệ:\n- " + string.Join("\n- ", errors));
        Directory.CreateDirectory(Dir);
        wf.Version = 1;
        File.WriteAllText(PathOf(id), Writer.Serialize(wf));
    }

    string PathOf(string id)
    {
        if (!IdPattern.IsMatch(id)) throw new InvalidOperationException($"Id workflow không hợp lệ: '{id}'");
        return Path.Combine(Dir, id + ".yml");
    }

    public List<string> Validate(WorkflowDef wf)
    {
        var errors = new List<string>();
        if (string.IsNullOrWhiteSpace(wf.Name)) errors.Add("Thiếu name");
        foreach (var f in wf.Folders) CheckFolder(f, errors);
        if (wf.Folders.Distinct(StringComparer.OrdinalIgnoreCase).Count() != wf.Folders.Count) errors.Add("Folder bị trùng");
        if (wf.Defaults.TimeoutSeconds <= 0) errors.Add("defaults.timeoutSeconds phải > 0");
        CheckVars(wf.Defaults.CommitPattern, CommitVars, "defaults.commitPattern", errors);
        if (wf.Defaults.PsHost is not ("pwsh" or "powershell.exe")) errors.Add("defaults.psHost phải là pwsh hoặc powershell.exe");

        foreach (var dup in wf.Steps.GroupBy(s => s.Id).Where(g => g.Count() > 1))
            errors.Add($"Id step bị trùng: '{dup.Key}'");

        foreach (var s in wf.Steps)
        {
            var at = $"step '{s.Id}'";
            if (!IdPattern.IsMatch(s.Id)) errors.Add($"{at}: id chỉ gồm chữ, số, . _ -");
            if (string.IsNullOrWhiteSpace(s.Name)) errors.Add($"{at}: thiếu name");
            if (string.IsNullOrWhiteSpace(s.Message)) errors.Add($"{at}: thiếu message");
            if (s.Kind == "app")
            {
                if (string.IsNullOrWhiteSpace(s.App)) errors.Add($"{at}: kind app phải có app");
                if (s.Shell is not ("cmd" or "powershell")) errors.Add($"{at}: kind app phải có shell (cmd | powershell)");
                if (s.PsHost is not (null or "pwsh" or "powershell.exe")) errors.Add($"{at}: psHost phải là pwsh hoặc powershell.exe");
                CheckVars(s.App ?? "", CommandVars, $"{at}.app", errors);
                foreach (var a in s.Args ?? new()) CheckVars(a, CommandVars, $"{at}.args", errors);
            }
            else if (s.Kind == "manual")
            {
                if (string.IsNullOrWhiteSpace(s.Guide)) errors.Add($"{at}: kind manual phải có guide");
            }
            else errors.Add($"{at}: kind phải là app hoặc manual");

            if (s.TimeoutSeconds is <= 0) errors.Add($"{at}: timeoutSeconds phải > 0");
            if (s.CommitPattern != null) CheckVars(s.CommitPattern, CommitVars, $"{at}.commitPattern", errors);
            foreach (var f in s.Folders ?? new())
                if (!wf.Folders.Contains(f)) errors.Add($"{at}: folder '{f}' không có trong danh sách folders");
        }
        return errors;
    }

    static readonly string[] CommandVars = ["folder", "root"];
    static readonly string[] CommitVars = ["folder", "message", "step"];
    static readonly Regex VarPattern = new(@"\{([^{}]*)\}");

    static void CheckVars(string text, string[] allowed, string at, List<string> errors)
    {
        foreach (Match m in VarPattern.Matches(text))
            if (!allowed.Contains(m.Groups[1].Value))
                errors.Add($"{at}: biến '{m.Value}' không hợp lệ (chỉ dùng {string.Join(", ", allowed.Select(a => "{" + a + "}"))})");
    }

    void CheckFolder(string f, List<string> errors)
    {
        if (string.IsNullOrWhiteSpace(f) || Path.IsPathRooted(f) || f.Split('/', '\\').Contains(".."))
            errors.Add($"Folder '{f}' phải là đường dẫn tương đối, không chứa ..");
        else if (!Directory.Exists(Path.Combine(repo.Root, f)))
            errors.Add($"Folder '{f}' không tồn tại trong repo");
    }
}
