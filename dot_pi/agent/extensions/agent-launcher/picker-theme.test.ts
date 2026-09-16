import assert from "node:assert/strict";
import test from "node:test";
import { createIssuePickerTheme } from "./picker-theme.ts";

const theme = {
  fg: (color: string, text: string) => `<fg:${color}>${text}</fg>`,
  bg: (color: string, text: string) => `<bg:${color}>${text}</bg>`,
};

test("selected issue rows use the theme foreground and selected background", () => {
  const pickerTheme = createIssuePickerTheme(theme);
  const row = "→ SERVER  ITA-123  Long issue title [blocked: ITA-122]";

  assert.equal(
    pickerTheme.selectedText(row),
    `<bg:selectedBg><fg:text>${row}</fg></bg>`,
  );
  assert.equal(pickerTheme.selectedPrefix("→ "), "<fg:accent>→ </fg>");
});

test("unselected supporting text remains readable with the theme", () => {
  const pickerTheme = createIssuePickerTheme(theme);

  assert.equal(pickerTheme.description("repository label and identifier"), "<fg:muted>repository label and identifier</fg>");
  assert.equal(pickerTheme.scrollInfo("(2/4)"), "<fg:muted>(2/4)</fg>");
  assert.equal(pickerTheme.noMatch("No matching issues"), "<fg:muted>No matching issues</fg>");
});
