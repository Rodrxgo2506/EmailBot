// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatePicker } from "./date-picker";
import { addMonthsToDay, formatDayInput, formatDayValue, monthGrid, monthTitle, parseDayKey, parseTypedDay, shiftMonth, WEEKDAYS } from "./date-picker-model";

describe("date picker model", () => {
  it("builds Monday-first months of 6 weeks", () => {
    const october = monthGrid({ year: 2026, month: 9 });
    expect(october).toHaveLength(6);
    expect(october[0]).toEqual([null, null, null, "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]); // 1 Oct 2026 is a Thursday
    expect(october.flat().filter(Boolean)).toHaveLength(31);
    expect(WEEKDAYS.map((weekday) => weekday.long)).toEqual(["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]);
  });

  it("handles leap years, month lengths and year changes", () => {
    expect(monthGrid({ year: 2028, month: 1 }).flat().filter(Boolean)).toHaveLength(29);
    expect(monthGrid({ year: 2027, month: 1 }).flat().filter(Boolean)).toHaveLength(28);
    expect(shiftMonth({ year: 2026, month: 11 }, 1)).toEqual({ year: 2027, month: 0 });
    expect(shiftMonth({ year: 2026, month: 0 }, -1)).toEqual({ year: 2025, month: 11 });
    expect(addMonthsToDay("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonthsToDay("2026-03-31", -1)).toBe("2026-02-28");
    expect(monthTitle({ year: 2027, month: 0 })).toBe("Enero de 2027");
  });

  it("parses only real local days", () => {
    expect(parseDayKey("2026-02-30")).toBeNull();
    expect(parseDayKey("2026-10-1")).toBeNull();
    expect(parseDayKey("")).toBeNull();
    expect(parseDayKey("2026-10-17")?.getDate()).toBe(17);
    expect(formatDayValue("2026-10-17")).toMatch(/^17 oct 2026$/);
  });

  it("reads typed days as local day keys and says why the rest are not days", () => {
    expect(parseTypedDay("17/10/2026")).toEqual({ ok: true, key: "2026-10-17" });
    expect(parseTypedDay(" 5/3/2026 ")).toEqual({ ok: true, key: "2026-03-05" });
    expect(parseTypedDay("05-03-2026")).toEqual({ ok: true, key: "2026-03-05" });
    expect(parseTypedDay("05.03.2026")).toEqual({ ok: true, key: "2026-03-05" });
    expect(parseTypedDay("05032026")).toEqual({ ok: true, key: "2026-03-05" });
    expect(parseTypedDay("2026-03-05")).toEqual({ ok: true, key: "2026-03-05" });
    expect(parseTypedDay("29/02/2028")).toEqual({ ok: true, key: "2028-02-29" });
    expect(parseTypedDay("29/02/2027")).toEqual({ ok: false, reason: "nonexistent" });
    expect(parseTypedDay("31/04/2026")).toEqual({ ok: false, reason: "nonexistent" });
    expect(parseTypedDay("13/13/2026")).toEqual({ ok: false, reason: "nonexistent" });
    expect(parseTypedDay("17/10")).toEqual({ ok: false, reason: "format" });
    expect(parseTypedDay("17/10/26")).toEqual({ ok: false, reason: "format" });
    expect(parseTypedDay("mañana")).toEqual({ ok: false, reason: "format" });
    expect(parseTypedDay("  ")).toEqual({ ok: false, reason: "empty" });
    expect(formatDayInput("2026-03-05")).toBe("05/03/2026");
    expect(formatDayInput("")).toBe("");
  });
});

function Harness({
  initial = "",
  onChange = vi.fn(),
  min,
  max,
  rangeHint
}: {
  initial?: string;
  onChange?: (value: string) => void;
  min?: string;
  max?: string;
  rangeHint?: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div>
      <DatePicker
        label="Desde"
        value={value}
        min={min}
        max={max}
        rangeHint={rangeHint}
        onChange={(next) => {
          setValue(next);
          onChange(next);
        }}
      />
      <button type="button">fuera</button>
    </div>
  );
}

const field = () => screen.getByRole("button", { name: /^desde/i });
const dialog = () => screen.getByRole("dialog");
const day = (pattern: RegExp) => within(dialog()).getByRole("button", { name: pattern });
const typedField = () => within(dialog()).getByRole("textbox", { name: /escribir fecha/i });
const closed = () => waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

describe("DatePicker", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 17, 12, 0, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("empty: shows the label, opens on today's month with today marked and focused", () => {
    render(<Harness />);
    expect(field()).toHaveAccessibleName("Desde sin fecha");
    fireEvent.click(field());
    expect(field()).toHaveAttribute("aria-expanded", "true");
    expect(dialog()).toHaveAccessibleName("Desde Octubre de 2026");
    const today = day(/17 de octubre de 2026/);
    expect(today).toHaveAttribute("aria-current", "date");
    expect(today).toHaveFocus();
    expect(screen.getByRole("button", { name: "Eliminar fecha" })).toBeDisabled();
    expect(within(dialog()).getAllByRole("columnheader").map((header) => header.getAttribute("aria-label"))[0]).toBe("lunes");
  });

  it("choosing a day sets it, closes and shows it on the field", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(field());
    fireEvent.click(day(/, 5 de octubre de 2026/));
    expect(onChange).toHaveBeenCalledWith("2026-10-05");
    await closed();
    expect(field()).toHaveAccessibleName("Desde 5 oct 2026");
    expect(field()).toHaveFocus();
  });

  it("a set value opens on its own month, selected and distinct from today", () => {
    render(<Harness initial="2026-03-09" />);
    fireEvent.click(field());
    expect(within(dialog()).getByRole("heading")).toHaveTextContent("Marzo de 2026");
    const selected = day(/, 9 de marzo de 2026/);
    expect(selected.closest("[role='gridcell']")).toHaveAttribute("aria-selected", "true");
    expect(selected).not.toHaveAttribute("aria-current");
  });

  it("month arrows navigate (across years) without selecting anything", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} initial="2026-12-15" />);
    fireEvent.click(field());
    fireEvent.click(screen.getByRole("button", { name: "Mes siguiente" }));
    expect(within(dialog()).getByRole("heading")).toHaveTextContent("Enero de 2027");
    fireEvent.click(screen.getByRole("button", { name: "Mes anterior" }));
    fireEvent.click(screen.getByRole("button", { name: "Mes anterior" }));
    expect(within(dialog()).getByRole("heading")).toHaveTextContent("Noviembre de 2026");
    expect(onChange).not.toHaveBeenCalled();
    expect(dialog()).toBeInTheDocument();
  });

  it("keyboard: arrows, Home / End and PageDown move the focus; Enter selects", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(field());
    const grid = within(dialog()).getByRole("grid");
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    expect(day(/18 de octubre/)).toHaveFocus();
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(day(/25 de octubre/)).toHaveFocus();
    fireEvent.keyDown(grid, { key: "Home" });
    expect(day(/19 de octubre/)).toHaveFocus(); // Monday of that week
    fireEvent.keyDown(grid, { key: "End" });
    expect(day(/25 de octubre/)).toHaveFocus();
    fireEvent.keyDown(grid, { key: "PageDown" });
    await waitFor(() => expect(day(/25 de noviembre de 2026/)).toHaveFocus());
    fireEvent.keyDown(grid, { key: "PageDown", shiftKey: true });
    await waitFor(() => expect(day(/25 de noviembre de 2027/)).toHaveFocus());
    fireEvent.click(day(/25 de noviembre de 2027/));
    expect(onChange).toHaveBeenCalledWith("2027-11-25");
  });

  it("days outside min / max are marked and cannot be chosen", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} min="2026-10-10" max="2026-10-20" />);
    fireEvent.click(field());
    const early = day(/, 9 de octubre/);
    expect(early).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(early);
    fireEvent.click(day(/, 21 de octubre/));
    expect(onChange).not.toHaveBeenCalled();
    expect(dialog()).toBeInTheDocument();
    expect(day(/, 10 de octubre/)).not.toHaveAttribute("aria-disabled");
  });

  it("'Eliminar fecha' clears the value and closes", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} initial="2026-10-05" />);
    fireEvent.click(field());
    fireEvent.click(screen.getByRole("button", { name: "Eliminar fecha" }));
    expect(onChange).toHaveBeenCalledWith("");
    await closed();
    expect(field()).toHaveAccessibleName("Desde sin fecha");
  });

  it("Escape and a press outside close it without changes", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(field());
    fireEvent.keyDown(dialog(), { key: "Escape" });
    await closed();
    expect(field()).toHaveFocus();
    fireEvent.click(field());
    fireEvent.pointerDown(screen.getByRole("button", { name: "fuera" }));
    await closed();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a day can be typed (dd/mm/aaaa) and applied with Enter: it is set, the calendar closes, the focus returns", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(field());
    expect(typedField()).toHaveValue("");
    fireEvent.change(typedField(), { target: { value: "5/3/2025" } });
    expect(within(dialog()).getByRole("heading")).toHaveTextContent("Marzo de 2025"); // shown, not chosen yet
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(typedField(), { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("2025-03-05");
    await closed();
    expect(field()).toHaveAccessibleName("Desde 5 mar 2025");
    expect(field()).toHaveFocus();
  });

  it("typed days: the current value is prefilled; 'Aplicar' also applies; ddmmaaaa works without separators", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} initial="2026-10-05" />);
    fireEvent.click(field());
    expect(typedField()).toHaveValue("05/10/2026");
    fireEvent.change(typedField(), { target: { value: "24122026" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Aplicar" }));
    expect(onChange).toHaveBeenCalledWith("2026-12-24");
    await closed();
  });

  it("incomplete and non-existent typed days are explained and not applied", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(field());
    fireEvent.change(typedField(), { target: { value: "31/02/2026" } });
    fireEvent.keyDown(typedField(), { key: "Enter" });
    expect(within(dialog()).getByRole("alert")).toHaveTextContent("Esa fecha no existe.");
    expect(typedField()).toHaveAttribute("aria-invalid", "true");
    expect(typedField()).toHaveAccessibleDescription("Esa fecha no existe.");
    fireEvent.change(typedField(), { target: { value: "10/2026" } });
    expect(within(dialog()).queryByRole("alert")).not.toBeInTheDocument(); // the message goes away while correcting
    fireEvent.keyDown(typedField(), { key: "Enter" });
    expect(within(dialog()).getByRole("alert")).toHaveTextContent("Escribe la fecha completa: dd/mm/aaaa.");
    expect(onChange).not.toHaveBeenCalled();
    expect(dialog()).toBeInTheDocument();
  });

  it("typed days keep the min / max bounds", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} min="2026-10-10" max="2026-10-20" />);
    fireEvent.click(field());
    fireEvent.change(typedField(), { target: { value: "09/10/2026" } });
    fireEvent.keyDown(typedField(), { key: "Enter" });
    expect(within(dialog()).getByRole("alert")).toHaveTextContent("Elige una fecha desde el 10 oct 2026.");
    fireEvent.change(typedField(), { target: { value: "21/10/2026" } });
    fireEvent.keyDown(typedField(), { key: "Enter" });
    expect(within(dialog()).getByRole("alert")).toHaveTextContent("Elige una fecha hasta el 20 oct 2026.");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(typedField(), { target: { value: "20/10/2026" } });
    fireEvent.keyDown(typedField(), { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("2026-10-20");
  });

  it("a bound is explained in the open calendar only (and describes the unavailable days)", () => {
    const { unmount } = render(<Harness min="2026-10-10" rangeHint="«Hasta» no puede ser anterior a «Desde» (10 oct 2026)." />);
    expect(screen.queryByText(/no puede ser anterior/)).not.toBeInTheDocument(); // nothing while closed
    fireEvent.click(field());
    expect(dialog()).toHaveAccessibleDescription("«Hasta» no puede ser anterior a «Desde» (10 oct 2026).");
    expect(day(/, 9 de octubre/)).toHaveAccessibleDescription("«Hasta» no puede ser anterior a «Desde» (10 oct 2026).");
    expect(day(/, 11 de octubre/)).not.toHaveAccessibleDescription();
    unmount();

    render(<Harness max="2026-10-20" />);
    fireEvent.click(field());
    expect(dialog()).toHaveAccessibleDescription("Fechas disponibles hasta el 20 oct 2026.");
  });

  it("without bounds there is no hint", () => {
    render(<Harness />);
    fireEvent.click(field());
    expect(dialog()).not.toHaveAccessibleDescription();
    expect(within(dialog()).queryByText(/disponibles/)).not.toBeInTheDocument();
  });
});
