// EmptyState.tsx — what the centre of the app shows before any file is loaded: the logo, how to
// begin, the tutorial for someone new, and a word on the window.

import brandLogo from "../assets/brand/gatelab-logo.jpg";
import brandLogoR from "../assets/brand/gatelabr-logo.jpg";
import { useI18n } from "./i18n";

export function EmptyState({ brand, tutorial }: {
  /** Whose logo is shown: the browser app's, or the R package's. */
  brand: "GateLab" | "GateLabR";
  /** The tutorial's entry points, where the host offers it; null where it does not. */
  tutorial: { paused: boolean; onStart: () => void; onResume: () => void } | null;
}) {
  const { t } = useI18n();
  return (
    <div className="gl-center gl-empty gl-splash" role="main" aria-label={t("Plot and analysis tabs")}>
      <img className="gl-splash-logo" src={brand === "GateLabR" ? brandLogoR : brandLogo} alt={brand} />
      <p className="gl-splash-title">{t("Open an FCS file or a workspace to begin.")}</p>
      {tutorial && (
        <p className="gl-splash-tutorial">
          {t("New to GateLab?")}{" "}
          <button className="gl-splash-link" onClick={tutorial.paused ? tutorial.onResume : tutorial.onStart}>
            {tutorial.paused ? t("Resume the tutorial") : t("Start the tutorial")}
          </button>
        </p>
      )}
      <p className="gl-splash-hint">{t("Use a wide browser window.")}</p>
    </div>
  );
}
