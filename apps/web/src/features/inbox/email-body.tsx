import { ImageOff } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * Renders untrusted email HTML in a sandboxed iframe:
 *  - sandbox without allow-scripts / allow-same-origin (no JS, no access to the app),
 *  - CSP inside the document blocks remote resources by default
 *    (tracking pixels) until the user opts in,
 *  - links open in a new tab without referrer.
 */
export function buildEmailDocument(html: string, allowRemoteImages: boolean): string {
  const imgSrc = allowRemoteImages ? "data: cid: https:" : "data: cid:";
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline'; font-src data:">
<meta name="referrer" content="no-referrer"><base target="_blank">
<style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:14px;line-height:1.5;color:#1f2430;margin:16px;word-wrap:break-word}img{max-width:100%;height:auto}table{max-width:100%}</style>
</head><body>${html}</body></html>`;
}

export function EmailBody({ html, text }: { html: string | null; text: string | null }) {
  const [mode, setMode] = useState<"html" | "text">(html ? "html" : "text");
  const [allowImages, setAllowImages] = useState(false);
  const document = useMemo(() => (html ? buildEmailDocument(html, allowImages) : ""), [html, allowImages]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {html && text ? (
          <div className="inline-flex rounded-md border p-0.5" role="tablist" aria-label="Formato del contenido">
            {(["html", "text"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={mode === value}
                onClick={() => setMode(value)}
                className={`rounded px-2.5 py-1 text-xs ${mode === value ? "bg-accent font-medium" : "text-muted-foreground"}`}
              >
                {value === "html" ? "HTML" : "Texto"}
              </button>
            ))}
          </div>
        ) : null}
        {mode === "html" && html && !allowImages ? (
          <Button variant="ghost" size="sm" onClick={() => setAllowImages(true)}>
            <ImageOff /> Imágenes remotas bloqueadas · Mostrar
          </Button>
        ) : null}
      </div>

      {mode === "html" && html ? (
        <iframe
          title="Contenido del correo"
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          srcDoc={document}
          className="h-[60vh] min-h-80 w-full rounded-md border bg-white"
        />
      ) : (
        <pre className="max-h-[60vh] min-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-4 font-sans text-sm">
          {text ?? "(sin contenido de texto)"}
        </pre>
      )}
    </div>
  );
}
