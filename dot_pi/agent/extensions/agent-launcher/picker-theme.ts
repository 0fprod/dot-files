export type IssuePickerThemeColor = "accent" | "muted" | "text";

export interface IssuePickerTheme {
  fg(color: IssuePickerThemeColor, text: string): string;
  bg(color: "selectedBg", text: string): string;
}

export function createIssuePickerTheme(theme: IssuePickerTheme) {
  return {
    selectedPrefix: (text: string) => theme.fg("accent", text),
    selectedText: (text: string) => theme.bg("selectedBg", theme.fg("text", text)),
    description: (text: string) => theme.fg("muted", text),
    scrollInfo: (text: string) => theme.fg("muted", text),
    noMatch: (text: string) => theme.fg("muted", text),
  };
}
