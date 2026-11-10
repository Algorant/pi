import { Text } from "@earendil-works/pi-tui";

const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;
export function createRequestMetricsRenderer(visible: () => boolean) {
  return (entry: any, options: { expanded?: boolean }, theme: any) => {
    let content: Text | undefined;
    return {
      render(width: number): string[] {
        if (!visible()) return [];
        content ??= renderMetrics(entry, options, theme);
        return content.render(width);
      },
      invalidate() { content = undefined; },
    };
  };
}

function renderMetrics(entry: any, options: { expanded?: boolean }, theme: any): Text {
  const d = entry.data;
  if (!d) return new Text(theme.fg("warning", "Request metrics unavailable"), 0, 0);
  if (d.stage === "timing") {
    return new Text(theme.fg("muted", `Response #${d.sequence} · ${d.headersMs === undefined ? "headers unobserved" : `headers ${d.headersMs} ms`} · ${d.firstEventMs === undefined ? "first event unobserved" : `first parsed event ${d.firstEventMs} ms`}`), 0, 0);
  }
  const lines = [theme.fg("muted", `Request #${d.sequence} · ${size(d.jsonBytes)} JSON · ${d.imageCount} images / ${size(d.base64Bytes)} base64`)];
  if (options.expanded) {
    lines.push(theme.fg("dim", `${d.contextProvider}/${d.model} · decoded images ${size(d.decodedBytes)} · other JSON ${size(d.otherJsonBytes)}`));
    lines.push(theme.fg("dim", "Provider payload hook after owned transforms; excludes HTTP/TLS overhead and standalone compaction/custom-fetch requests."));
  }
  return new Text(lines.join("\n"), 0, 0);
}
