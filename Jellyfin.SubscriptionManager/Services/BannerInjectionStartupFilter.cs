using System.Text;
using System.IO.Compression;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.SubscriptionManager.Services;

/// <summary>
/// Adds the plugin's own client banner to Jellyfin Web's entry HTML without
/// changing the installed jellyfin-web files or depending on a JS injector.
/// Only a successful HTML entry-point response is modified; no API or media
/// response is buffered. Native clients do not render this script.
/// </summary>
public sealed class BannerInjectionStartupFilter : IStartupFilter
{
    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next)
        => app =>
        {
            app.UseMiddleware<BannerInjectionMiddleware>();
            next(app);
        };
}

public sealed class BannerInjectionMiddleware
{
    private readonly RequestDelegate _next;
    private readonly ILogger<BannerInjectionMiddleware> _logger;

    public BannerInjectionMiddleware(RequestDelegate next, ILogger<BannerInjectionMiddleware> logger)
    {
        _next = next;
        _logger = logger;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        if (!HttpMethods.IsGet(context.Request.Method) || !LooksLikeWebEntry(context.Request.Path.Value))
        {
            await _next(context).ConfigureAwait(false);
            return;
        }

        var originalBody = context.Response.Body;
        await using var buffer = new MemoryStream();
        context.Response.Body = buffer;
        try
        {
            await _next(context).ConfigureAwait(false);
            buffer.Position = 0;
            if (context.Response.StatusCode != StatusCodes.Status200OK ||
                context.Response.ContentType?.StartsWith("text/html", StringComparison.OrdinalIgnoreCase) != true)
            {
                context.Response.Body = originalBody;
                await buffer.CopyToAsync(originalBody, context.RequestAborted).ConfigureAwait(false);
                return;
            }

            var encoding = context.Response.Headers["Content-Encoding"].ToString().Trim().ToLowerInvariant();
            if (encoding is not ("" or "gzip" or "br"))
            {
                context.Response.Body = originalBody;
                buffer.Position = 0;
                await buffer.CopyToAsync(originalBody, context.RequestAborted).ConfigureAwait(false);
                return;
            }
            var raw = buffer.ToArray();
            byte[] decoded;
            if (encoding.Length == 0) decoded = raw;
            else
            {
                using var source = new MemoryStream(raw);
                using Stream decompressor = encoding == "gzip"
                    ? new GZipStream(source, CompressionMode.Decompress)
                    : new BrotliStream(source, CompressionMode.Decompress);
                using var decodedStream = new MemoryStream();
                await decompressor.CopyToAsync(decodedStream, context.RequestAborted).ConfigureAwait(false);
                decoded = decodedStream.ToArray();
            }
            var html = Encoding.UTF8.GetString(decoded);
            var headEnd = html.IndexOf("</head>", StringComparison.OrdinalIgnoreCase);
            if (headEnd < 0 || html.Contains("data-subscription-manager-banner", StringComparison.Ordinal))
            {
                context.Response.Body = originalBody;
                buffer.Position = 0;
                await buffer.CopyToAsync(originalBody, context.RequestAborted).ConfigureAwait(false);
                return;
            }

            // PathBase is provided by ASP.NET Core for installations under a sub-path.
            var prefix = context.Request.PathBase.Value?.TrimEnd('/') ?? string.Empty;
            var tag = $"<script data-subscription-manager-banner defer src=\"{prefix}/SubscriptionManager/banner.js\"></script>";
            var output = Encoding.UTF8.GetBytes(html.Insert(headEnd, tag));
            if (encoding.Length != 0)
            {
                using var compressed = new MemoryStream();
                using (Stream compressor = encoding == "gzip"
                    ? new GZipStream(compressed, CompressionLevel.Fastest, leaveOpen: true)
                    : new BrotliStream(compressed, CompressionLevel.Fastest, leaveOpen: true))
                {
                    await compressor.WriteAsync(output, context.RequestAborted).ConfigureAwait(false);
                }
                output = compressed.ToArray();
            }
            context.Response.Headers.Remove("ETag");
            context.Response.Headers.Remove("Last-Modified");
            context.Response.Headers.Remove("Content-MD5");
            context.Response.Headers["Cache-Control"] = "no-cache";
            context.Response.ContentLength = output.Length;
            context.Response.Body = originalBody;
            await originalBody.WriteAsync(output, context.RequestAborted).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            context.Response.Body = originalBody;
            _logger.LogError(ex, "Unable to inject subscription banner into Jellyfin Web");
            throw;
        }
        finally
        {
            context.Response.Body = originalBody;
        }
    }

    private static bool LooksLikeWebEntry(string? path)
    {
        var p = (path ?? string.Empty).TrimEnd('/');
        return p.Length == 0 || p.Equals("/web", StringComparison.OrdinalIgnoreCase) ||
               p.EndsWith("/web/index.html", StringComparison.OrdinalIgnoreCase) ||
               p.Equals("/index.html", StringComparison.OrdinalIgnoreCase);
    }
}
