import { useState, useEffect } from "react";

const STORAGE_KEY = "apply_mode";

/**
 * useApplyMode — persists "automatic" | "manual" across page refreshes.
 * Syncs across browser tabs via the "storage" event.
 */
export function useApplyMode() {
  const [applyMode, setApplyModeState] = useState(
    () => localStorage.getItem(STORAGE_KEY) || "automatic"
  );

  const setApplyMode = (mode) => {
    localStorage.setItem(STORAGE_KEY, mode);
    setApplyModeState(mode);
  };

  // Keep in sync when another tab changes it
  useEffect(() => {
    const handler = (e) => {
      if (e.key === STORAGE_KEY) {
        setApplyModeState(e.newValue || "automatic");
      }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  return {
    applyMode,
    setApplyMode,
    isManual: applyMode === "manual",
  };
}
