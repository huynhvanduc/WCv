using System.Diagnostics;
using Microsoft.Extensions.FileProviders;
using WorkflowRunner;

// git gọi lại chính exe này làm GIT_SEQUENCE_EDITOR: đổi "pick <sha>" thành "edit <sha>" rồi thoát
if (args is ["--mark-edit", var sha, var todoFile])
{
    var lines = File.ReadAllLines(todoFile).Select(l =>
        l.Split(' ') is ["pick", var h, ..] && sha.StartsWith(h) ? "edit" + l[4..] : l);
    File.WriteAllLines(todoFile, lines);
    return;
}

Console.OutputEncoding = System.Text.Encoding.UTF8;

// Tham số là thư mục repo, bỏ trống = thư mục hiện tại
var root = await FindRepoRoot(args.FirstOrDefault(a => !a.StartsWith("--")) ?? Directory.GetCurrentDirectory());
if (root == null) { Console.Error.WriteLine("Không phải git repo. Dùng: WorkflowRunner.exe <thư mục repo>"); Environment.Exit(1); }

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls("http://127.0.0.1:5057");            // chỉ máy này vào được
builder.Configuration["AllowedHosts"] = "localhost;127.0.0.1"; // chặn trang web lạ gọi vào qua DNS rebinding
builder.Logging.SetMinimumLevel(LogLevel.Warning);
builder.Services.ConfigureHttpJsonOptions(o =>
{
    o.SerializerOptions.PropertyNamingPolicy = StateStore.Json.PropertyNamingPolicy;
    foreach (var c in StateStore.Json.Converters) o.SerializerOptions.Converters.Add(c);
});
builder.Services.AddSingleton(new Repo(root)).AddSingleton<WorkflowStore>().AddSingleton<StateStore>()
                .AddSingleton<Shell>().AddSingleton<Git>().AddSingleton<Runner>();
var app = builder.Build();

// Lỗi nghiệp vụ → 409 kèm lý do
app.Use(async (ctx, next) =>
{
    try { await next(); }
    catch (InvalidOperationException e)
    {
        ctx.Response.StatusCode = StatusCodes.Status409Conflict;
        await ctx.Response.WriteAsJsonAsync(new { error = e.Message });
    }
});

// wwwroot cạnh exe được ưu tiên (sửa UI không cần build lại), thiếu file nào thì lấy bản nhúng trong exe
IFileProvider web = new ManifestEmbeddedFileProvider(typeof(Runner).Assembly, "wwwroot");
// Khi dev (F5 trong VS, ASPNETCORE_ENVIRONMENT=Development) đọc thẳng wwwroot của project
var diskWeb = app.Environment.IsDevelopment() ? Path.Combine(app.Environment.ContentRootPath, "wwwroot")
                                              : Path.Combine(AppContext.BaseDirectory, "wwwroot");
if (Directory.Exists(diskWeb)) web = new CompositeFileProvider(new PhysicalFileProvider(diskWeb), web);
app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = web });
app.UseStaticFiles(new StaticFileOptions { FileProvider = web });

var runner = app.Services.GetRequiredService<Runner>();
await runner.InitAsync();

app.MapGet("/api/workflow", (WorkflowStore s, string id) =>
{
    var (wf, errors) = s.Read(id);
    return Results.Ok(new { id, workflow = wf, errors });
});
app.MapPut("/api/workflow", (WorkflowStore s, Runner r, string id, WorkflowDef wf) =>
{
    // Sửa YAML trong lúc có lần chạy dở làm repo có thay đổi, nên màn Thiết lập chỉ xem
    if (r.State.InProgress) throw new InvalidOperationException("Đang có lần chạy dở: màn Thiết lập chỉ xem");
    if (r.State.Amend != null) throw new InvalidOperationException("Đang sửa commit cũ (file trên đĩa là bản cũ): màn Thiết lập chỉ xem");
    s.Save(id, wf);
    return Results.Ok();
});

var run = app.MapGroup("/api/run");
run.MapGet("/", async (Runner r, int? logFrom) => Results.Content(await r.SnapshotAsync(logFrom ?? 0), "application/json"));
run.MapPost("/start", async (Runner r, StartBody b) => { await r.StartRunAsync(b.Workflow); return Results.Ok(); });
run.MapPost("/reset", async (Runner r) => { await r.ResetAsync(); return Results.Ok(); });
run.MapPost("/steps/{id}/run", async (Runner r, string id) => { await r.RunStepAsync(id); return Results.Accepted(); });
run.MapPost("/until/{id}", async (Runner r, string id) => { await r.RunUntilAsync(id); return Results.Accepted(); });
run.MapPost("/steps/{id}/manual-done", async (Runner r, string id) => { await r.ManualDoneAsync(id); return Results.Ok(); });
run.MapPost("/steps/{id}/skip", async (Runner r, string id) => { await r.SkipAsync(id); return Results.Ok(); });
run.MapPost("/steps/{id}/commit-all", async (Runner r, string id, CommitAllBody? b) => { await r.CommitAllAsync(id, b?.Messages); return Results.Ok(); });
run.MapPost("/pause", async (Runner r) => { await r.PauseAsync(true); return Results.Ok(); });
run.MapPost("/resume", async (Runner r) => { await r.PauseAsync(false); return Results.Ok(); });
run.MapPost("/steps/{id}/folders/{**folder}", async (Runner r, string id, string folder, MessageBody? b) =>
{
    // {folder} có thể chứa "/", nên action nằm ở đoạn cuối: .../folders/src/Api/commit
    var cut = folder.LastIndexOf('/');
    var (name, action) = cut < 0 ? ("", folder) : (folder[..cut], folder[(cut + 1)..]);
    switch (action)
    {
        case "commit":  await r.CommitAsync(id, name, b?.Message ?? ""); return Results.Ok();
        case "restore": await r.RestoreAsync(id, name); return Results.Ok();
        case "rerun":   await r.RerunFolderAsync(id, name); return Results.Accepted();
        default:        return Results.NotFound();
    }
});
run.MapPost("/next", async (Runner r) => { await r.NextAsync(); return Results.Ok(); });

var amend = app.MapGroup("/api/amend");
amend.MapGet("/preview", async (Runner r, string sha) => Results.Ok(await r.AmendPreviewAsync(sha)));
amend.MapPost("/start", async (Runner r, ShaBody b) => { await r.AmendStartAsync(b.Sha); return Results.Ok(); });
amend.MapPost("/finish", async (Runner r, MessageBody? b) => Results.Ok(await r.AmendFinishAsync(b?.Message)));
amend.MapPost("/abort", async (Runner r) => { await r.AmendAbortAsync(); return Results.Ok(); });

app.Lifetime.ApplicationStarted.Register(() =>
{
    Console.WriteLine($"Workflow Runner: {root}\nMở http://127.0.0.1:5057 — Ctrl+C để tắt");
    if (!args.Contains("--no-browser"))
        Process.Start(new ProcessStartInfo("http://127.0.0.1:5057") { UseShellExecute = true });   // mở trình duyệt
});
app.Run();

static async Task<string?> FindRepoRoot(string dir)
{
    if (!Directory.Exists(dir)) return null;
    var psi = new ProcessStartInfo("git", ["-C", dir, "rev-parse", "--show-toplevel"]) {
        RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
    using var p = Process.Start(psi)!;
    var output = (await p.StandardOutput.ReadToEndAsync()).Trim();
    await p.WaitForExitAsync();
    return p.ExitCode == 0 ? Path.GetFullPath(output) : null;
}

record StartBody(string Workflow);
record MessageBody(string? Message);
record ShaBody(string Sha);
record CommitAllBody(Dictionary<string, string>? Messages);
