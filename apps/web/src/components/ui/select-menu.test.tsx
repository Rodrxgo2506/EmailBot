// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { SelectMenu, type SelectMenuOption } from "./select-menu";

const OPTIONS: SelectMenuOption[] = [
  { value: "", label: "Todas las categorías" },
  { value: "voley", label: "Vóley playa" },
  { value: "canchas", label: "Canchas deportivas" }
];

function Harness({ onChange = vi.fn(), initial = "" }: { onChange?: (value: string) => void; initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <div>
      <SelectMenu
        label="Categoría"
        value={value}
        options={OPTIONS}
        onValueChange={(next) => {
          setValue(next);
          onChange(next);
        }}
      />
      <button type="button">fuera</button>
    </div>
  );
}

const trigger = () => screen.getByRole("button", { name: /^categoría/i });
const closed = () => waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());

describe("SelectMenu", () => {
  it("shows the selected option on the control and announces it after the label", () => {
    render(<Harness initial="voley" />);
    expect(trigger()).toHaveAccessibleName("Categoría Vóley playa");
    expect(trigger()).toHaveAttribute("aria-haspopup", "listbox");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
  });

  it("opens on click with every option, the selected one marked, and focus in the list", () => {
    render(<Harness initial="canchas" />);
    fireEvent.click(trigger());
    const list = screen.getByRole("listbox", { name: "Categoría" });
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    expect(trigger()).toHaveAttribute("aria-controls", list.id);
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(OPTIONS.map((option) => option.label));
    expect(screen.getByRole("option", { name: "Canchas deportivas" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: "Vóley playa" })).toHaveAttribute("aria-selected", "false");
    expect(list).toHaveFocus();
    expect(list).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: "Canchas deportivas" }).id);
  });

  it("choosing an option updates the value once, closes the menu and returns the focus", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("option", { name: "Vóley playa" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("voley");
    await closed();
    expect(trigger()).toHaveAccessibleName("Categoría Vóley playa");
    expect(trigger()).toHaveFocus();
  });

  it("choosing the option already selected does not fire a change", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} initial="voley" />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("option", { name: "Vóley playa" }));
    expect(onChange).not.toHaveBeenCalled();
    await closed();
  });

  it("keyboard: ArrowDown opens, arrows / Home / End / first letter move, Enter chooses", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    const list = screen.getByRole("listbox");
    const active = () => list.getAttribute("aria-activedescendant");
    const idOf = (name: string) => screen.getByRole("option", { name }).id;
    expect(active()).toBe(idOf("Todas las categorías"));
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(active()).toBe(idOf("Vóley playa"));
    fireEvent.keyDown(list, { key: "End" });
    expect(active()).toBe(idOf("Canchas deportivas"));
    fireEvent.keyDown(list, { key: "ArrowDown" }); // stays on the last one
    expect(active()).toBe(idOf("Canchas deportivas"));
    fireEvent.keyDown(list, { key: "Home" });
    expect(active()).toBe(idOf("Todas las categorías"));
    fireEvent.keyDown(list, { key: "v" });
    expect(active()).toBe(idOf("Vóley playa"));
    fireEvent.keyDown(list, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("voley");
    await closed();
  });

  it("Escape closes without changing anything and focuses the control", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(trigger());
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    await closed();
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger()).toHaveFocus();
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
  });

  it("a press outside closes it; clicking the control again closes it too", async () => {
    render(<Harness />);
    fireEvent.click(trigger());
    fireEvent.pointerDown(screen.getByRole("button", { name: "fuera" }));
    await closed();
    fireEvent.click(trigger());
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.click(trigger());
    await closed();
  });
});
