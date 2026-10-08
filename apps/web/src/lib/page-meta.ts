import { useEffect } from "react";

/** Default description of index.html, restored when a page with its own description unmounts. */
const DEFAULT_DESCRIPTION =
  "EmailBot conecta tus cuentas de correo, procesa con reglas solo los mensajes que te interesan y entrega a cada cliente lo que le corresponde.";

function descriptionTag(): HTMLMetaElement {
  let tag = document.head.querySelector<HTMLMetaElement>('meta[name="description"]');
  if (!tag) {
    tag = document.createElement("meta");
    tag.name = "description";
    document.head.appendChild(tag);
  }
  return tag;
}

/** Sets document.title and the meta description while the page is mounted (public pages, SEO). */
export function usePageMeta(title: string, description?: string) {
  useEffect(() => {
    const previousTitle = document.title;
    const tag = descriptionTag();
    const previousDescription = tag.content;
    document.title = title;
    tag.content = description ?? DEFAULT_DESCRIPTION;
    return () => {
      document.title = previousTitle;
      tag.content = previousDescription || DEFAULT_DESCRIPTION;
    };
  }, [title, description]);
}
