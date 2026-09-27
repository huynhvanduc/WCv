using System.ComponentModel;
using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;

namespace WorkflowRunner;

public class Shell
{
    // Chạy app của step trong thư mục của folder, trả exit code (-1 = timeout / không chạy được)
    // và dòng output cuối (tóm tắt cho UI); log đẩy từng dòng qua onLine
    public async Task<(int Exit, string Last)> RunAsync(StepDef step, string folder, string root, Defaults defaults, Action<string> onLine)
    {
        var folderPath = Path.GetFullPath(Path.Combine(root, folder));
        string Expand(string s) => s.Replace("{folder}", folderPath).Replace("{root}", root);

        var app = Expand(step.App!);
        // "tools\x.cmd" tương đối: tìm theo gốc repo trước, không có thì tìm cạnh WorkflowRunner.exe
        // (thư mục tools đi kèm tool); thư mục làm việc là folder nên không để nguyên đường dẫn tương đối
        if (!Path.IsPathRooted(app) && app.IndexOfAny(['\\', '/']) >= 0)
        {
            var found = new[] { root, AppContext.BaseDirectory }.Select(b => Path.Combine(b, app)).FirstOrDefault(File.Exists);
            if (found != null) app = Path.GetFullPath(found);
        }
        var args = (step.Args ?? new()).Select(Expand).ToList();
        var timeout = step.TimeoutSeconds ?? defaults.TimeoutSeconds;
        var last = "";
        void Out(string? line) { if (line is null) return; onLine(line); if (line.Trim() != "") last = line.Trim(); }

        var psi = new ProcessStartInfo {
            WorkingDirectory = folderPath,
            RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
            UseShellExecute = false, CreateNoWindow = true };

        if (step.Shell == "powershell")
        {
            psi.FileName = step.PsHost ?? defaults.PsHost;                    // pwsh | powershell.exe
            foreach (var a in new[] { "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command" })
                psi.ArgumentList.Add(a);
            // Stop: lỗi cmdlet cũng thành exit code != 0
            psi.ArgumentList.Add("[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ErrorActionPreference='Stop'; " +
                $"& {PsQuote(app, force: true)} {string.Join(' ', args.Select(a => PsQuote(a)))}; exit $LASTEXITCODE");
        }
        else
        {
            psi.FileName  = "cmd.exe";
            psi.Arguments = $"/d /s /c \"chcp 65001 >nul && {CmdQuote(app)} {string.Join(' ', args.Select(CmdQuote))}\"";
        }

        onLine($"$ [{folder}] {app} {string.Join(' ', args)}");
        Process p;
        try { p = Process.Start(psi)!; }
        catch (Win32Exception e) { onLine($"Không chạy được {psi.FileName}: {e.Message}"); return (-1, $"không chạy được {psi.FileName}"); }

        using (p)
        {
            p.OutputDataReceived += (_, e) => Out(e.Data);
            p.ErrorDataReceived  += (_, e) => Out(e.Data);
            p.BeginOutputReadLine(); p.BeginErrorReadLine();

            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(timeout));
            try
            {
                await p.WaitForExitAsync(cts.Token);
                onLine($"exit {p.ExitCode}");
                return (p.ExitCode, last);
            }
            catch (OperationCanceledException)
            {
                p.Kill(entireProcessTree: true);   // không thì process con (dotnet build...) vẫn giữ khóa file
                onLine($"TIMEOUT sau {timeout}s");
                return (-1, $"timeout sau {timeout}s");
            }
        }
    }

    static readonly Regex PsSafe = new(@"^[A-Za-z0-9_.:\\/+=-]+$");

    // Arg dạng -Framework hay chữ/số/đường dẫn đơn giản giữ nguyên để .ps1 nhận đúng tên tham số; còn lại bọc nháy đơn
    public static string PsQuote(string s, bool force = false) =>
        !force && s.Length > 0 && PsSafe.IsMatch(s) ? s : "'" + s.Replace("'", "''") + "'";

    static readonly char[] CmdSpecial = [' ', '\t', '&', '|', '<', '>', '^', '(', ')', '%', '!', ',', ';', '=', '"'];

    public static string CmdQuote(string s) =>
        s.Length > 0 && s.IndexOfAny(CmdSpecial) < 0 ? s : "\"" + s.Replace("\"", "\"\"") + "\"";
}
