import type { ReactNode } from "react";

interface StatusBannerProps {
  tone?: "info" | "success" | "error";
  children: ReactNode;
  onDismiss?: () => void;
}

export function StatusBanner({ tone = "info", children, onDismiss }: StatusBannerProps): JSX.Element {
  return (
    <div className={`status-banner status-banner--${tone}`} role={tone === "error" ? "alert" : "status"}>
      <span>{children}</span>
      {onDismiss ? <button className="icon-button status-banner__close" type="button" onClick={onDismiss} aria-label="关闭提示">×</button> : null}
    </div>
  );
}
