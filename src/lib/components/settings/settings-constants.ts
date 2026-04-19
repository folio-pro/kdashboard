import { Palette, Container, Keyboard } from "lucide-svelte";

export interface ThemeOption {
  id: string;
  name: string;
}

export interface ThemeColors {
  bg: string;
  fg: string;
  accent: string;
  secondary: string;
}

export const THEME_COLORS: Record<string, ThemeColors> = {
  "kdashboard":       { bg: "#0C0C0C", fg: "#E5E5E5", accent: "#21C45D", secondary: "#242424" },
  "gruvbox-dark":     { bg: "#2C2521", fg: "#E9E0CE", accent: "#E7A650", secondary: "#483B32" },
  "solarized-dark":   { bg: "#003C4D", fg: "#FDF6E2", accent: "#EA723E", secondary: "#1B535F" },
  "everforest-dark":  { bg: "#262C28", fg: "#DDE3D3", accent: "#8DAE5B", secondary: "#3C4940" },
  "dracula-dark":     { bg: "#272935", fg: "#F8F8F2", accent: "#BF95F9", secondary: "#3D4157" },
  "monokai-dark":     { bg: "#1D1D1B", fg: "#EDEDDE", accent: "#94EC55", secondary: "#3A3A36" },
  "gruvbox-light":    { bg: "#F9F5EB", fg: "#483B32", accent: "#C37D22", secondary: "#F4EEE2" },
  "solarized-light":  { bg: "#FDF6E2", fg: "#003C4D", accent: "#237DBE", secondary: "#F5F0E0" },
  "everforest-light": { bg: "#F2F7EE", fg: "#3B4436", accent: "#69883A", secondary: "#EBF1E4" },
  "rosepine-dawn":    { bg: "#F8F3ED", fg: "#484365", accent: "#CE5955", secondary: "#F2ECE4" },
  "github-light":     { bg: "#F5F7FA", fg: "#282C34", accent: "#0754AB", secondary: "#FAFBFC" },
};

export const LIGHT_THEMES: ThemeOption[] = [
  { id: "gruvbox-light", name: "Gruvbox Light" },
  { id: "solarized-light", name: "Solarized Light" },
  { id: "everforest-light", name: "Everforest Light" },
  { id: "rosepine-dawn", name: "Rose Pine Dawn" },
  { id: "github-light", name: "GitHub Light" },
];

export const DARK_THEMES: ThemeOption[] = [
  { id: "kdashboard", name: "kdashboard" },
  { id: "gruvbox-dark", name: "Gruvbox Dark" },
  { id: "solarized-dark", name: "Solarized Dark" },
  { id: "everforest-dark", name: "Everforest Dark" },
  { id: "dracula-dark", name: "Dracula" },
  { id: "monokai-dark", name: "Monokai" },
];

export const TABS = [
  { id: "general", label: "General", icon: Palette },
  { id: "kubernetes", label: "Kubernetes", icon: Container },
  { id: "shortcuts", label: "Shortcuts", icon: Keyboard },
] as const;

export type TabId = string;

export const COLOR_OPTIONS = [
  { id: "--accent", label: "Accent" },
  { id: "--status-succeeded", label: "Green" },
  { id: "--status-running", label: "Blue" },
  { id: "--status-pending", label: "Yellow" },
  { id: "--status-terminating", label: "Red" },
];

export const ICON_CATEGORIES = [
  { key: "cloud" as const, label: "Cloud" },
  { key: "infra" as const, label: "Infrastructure" },
  { key: "env" as const, label: "Environment" },
  { key: "generic" as const, label: "Generic" },
];
