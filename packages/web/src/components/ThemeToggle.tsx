"use client";
// Light/dark theme switch (INNOBOX_SPEC.md §2.2). Default follows the OS
// (prefers-color-scheme, applied pre-paint by the layout's inline script); clicking the
// toggle stores an explicit override in localStorage that wins from then on. While no
// override is stored, live OS theme changes keep being followed.
import { useEffect, useState } from "react";

const STORAGE_KEY = "innobox.theme";
type Theme = "light" | "dark";

function applyTheme(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
}

export function ThemeToggle() {
  // Server renders "light"; the real value is read from <html data-theme> after mount
  // (set pre-paint by the layout script), so hydration never mismatches.
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    const current = document.documentElement.getAttribute("data-theme");
    if (current === "dark" || current === "light") setTheme(current);

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const followOs = () => {
      if (localStorage.getItem(STORAGE_KEY)) return; // explicit choice wins
      const next: Theme = mq.matches ? "dark" : "light";
      applyTheme(next);
      setTheme(next);
    };
    mq.addEventListener("change", followOs);
    return () => mq.removeEventListener("change", followOs);
  }, []);

  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    applyTheme(next);
    setTheme(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // storage unavailable (private mode) — the theme still switches for this page
    }
  };

  return (
    <button
      type="button"
      className="toggle toggle-theme"
      role="switch"
      aria-checked={theme === "dark"}
      aria-label="Switch between light and dark theme"
      onClick={toggle}
    >
      <span className="toggle-knob" aria-hidden="true">
        {theme === "dark" ? "🌙" : "☀️"}
      </span>
    </button>
  );
}
