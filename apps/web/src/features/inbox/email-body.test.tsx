// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildEmailDocument, EmailBody } from "./email-body";

/*
 * EmailBody is shared by the main inbox (email-detail) and the customer
 * portal (portal-email-page): the same rendering and protections in both.
 */

const frameDocument = () => screen.getByTitle("Contenido del correo").getAttribute("srcdoc") ?? "";

describe("EmailBody", () => {
  it("HTML email: sanitized document in a sandboxed iframe (no scripts, no same-origin), remote images blocked until asked", () => {
    render(
      <EmailBody
        html={'<p style="color:#222">Tu código es <b>482913</b></p><img src="https://cdn.example/logo.png" onerror="alert(1)"><script>alert(2)</script>'}
        text="Tu código es 482913"
      />
    );
    const frame = screen.getByTitle("Contenido del correo");
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("sandbox")).toBe("allow-popups allow-popups-to-escape-sandbox");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");

    const srcdoc = frameDocument();
    expect(srcdoc).toContain('<p style="color:#222">Tu código es <b>482913</b></p>');
    expect(srcdoc).toContain("img-src data: cid:;");
    expect(srcdoc).toContain("form-action 'none'");
    expect(srcdoc).not.toContain("<script>alert");
    expect(srcdoc).not.toContain("onerror");
    expect(document.querySelector("script")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Imágenes remotas bloqueadas/ }));
    expect(frameDocument()).toContain("img-src data: cid: https:;");
  });

  it("HTML + text: the plain-text alternative is one click away", () => {
    render(<EmailBody html="<p>Hola <b>Juan</b></p>" text="Hola Juan" />);
    fireEvent.click(screen.getByRole("tab", { name: "Texto" }));
    expect(screen.queryByTitle("Contenido del correo")).not.toBeInTheDocument();
    expect(screen.getByText("Hola Juan")).toBeInTheDocument();
  });

  it("plain-text email: shown as text (no iframe), line breaks kept, the verification code visible", () => {
    render(<EmailBody html={null} text={"Hola,\nTu código de verificación es 731904.\nExpira en 10 minutos."} />);
    expect(screen.queryByTitle("Contenido del correo")).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    const text = screen.getByText(/Tu código de verificación es 731904/);
    expect(text.tagName).toBe("PRE");
    expect(text.textContent).toContain("\nExpira en 10 minutos.");
  });

  it("text that looks like HTML in a plain-text email is shown literally, never interpreted", () => {
    render(<EmailBody html={null} text={'<img src=x onerror="alert(1)"> hola'} />);
    expect(screen.getByText('<img src=x onerror="alert(1)"> hola')).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });

  it("no body available: says so instead of an empty box", () => {
    render(<EmailBody html={null} text={null} />);
    expect(screen.getByRole("status")).toHaveTextContent("El contenido de este correo no está disponible.");
    expect(screen.queryByTitle("Contenido del correo")).not.toBeInTheDocument();
  });

  it("buildEmailDocument always sanitizes, whatever the caller", () => {
    const html = buildEmailDocument('<a href="javascript:alert(1)">x</a><form action="https://evil.example"><p>y</p></form>', true);
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<form");
    expect(html).toContain("<p>y</p>");
  });
});
