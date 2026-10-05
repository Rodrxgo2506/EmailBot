import { describe, expect, it } from "vitest";
import { lastSyncText, SYNC_MESSAGES, syncOutcome } from "./portal-sync-model";

describe("portal sync model", () => {
  const now = Date.parse("2026-10-05T12:00:00.000Z");

  it("last sync text from the backend timestamp; nothing when unknown", () => {
    expect(lastSyncText(null, now)).toBeNull();
    expect(lastSyncText("not a date", now)).toBeNull();
    expect(lastSyncText("2026-10-05T11:59:55.000Z", now)).toBe("Última sincronización: hace unos segundos");
    expect(lastSyncText("2026-10-05T11:59:30.000Z", now)).toBe("Última sincronización: hace 30 segundos");
    expect(lastSyncText("2026-10-05T11:59:00.000Z", now)).toBe("Última sincronización: hace 1 minuto");
    expect(lastSyncText("2026-10-05T11:15:00.000Z", now)).toBe("Última sincronización: hace 45 minutos");
    expect(lastSyncText("2026-10-05T09:00:00.000Z", now)).toBe("Última sincronización: hace 3 horas");
    expect(lastSyncText("2026-10-03T12:00:00.000Z", now)).toBe("Última sincronización: hace 2 días");
  });

  it("success only when the newest email changed", () => {
    expect(syncOutcome("d1", "d2")).toBe("success");
    expect(syncOutcome(undefined, "d1")).toBe("success");
    expect(syncOutcome("d1", "d1")).toBe("no_new");
    expect(syncOutcome("d1", undefined)).toBe("no_new");
  });

  it("user-facing messages", () => {
    expect(SYNC_MESSAGES).toEqual({
      success: "Bandeja actualizada",
      no_new: "No hay correos nuevos",
      rate_limited: "Espera unos segundos antes de volver a actualizar.",
      error: "No pudimos actualizar la bandeja."
    });
  });
});
