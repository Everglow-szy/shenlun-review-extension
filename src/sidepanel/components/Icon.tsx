import type { SVGProps } from "react";

type IconName = "book" | "clock" | "history" | "panel" | "pause" | "pin" | "play" | "scan" | "settings" | "sparkles" | "success";

interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName;
}

const paths: Record<IconName, JSX.Element> = {
  book: <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H6.5A2.5 2.5 0 0 0 4 19.5v-14Zm16 0A2.5 2.5 0 0 0 17.5 3H13v16a2 2 0 0 1 2-2h2.5a2.5 2.5 0 0 1 2.5 2.5v-14Z" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></>,
  history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></>,
  panel: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></>,
  pause: <><path d="M8 5v14M16 5v14" /></>,
  pin: <><path d="m9 3 6 6M7.5 8.5l8 8M13.5 5.5l3-2 4 4-2 3M10.5 18.5 5 24l.5-6.5L8 15l-2.5-2.5 7-7" /></>,
  play: <path d="m9 6 9 6-9 6V6Z" />,
  scan: <><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" /><path d="M7 12h10" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></>,
  sparkles: <><path d="m12 3 1 3.2L16 7.5l-3 1.3-1 3.2-1-3.2-3-1.3 3-1.3L12 3ZM18 13l.7 2.2L21 16l-2.3.8L18 19l-.7-2.2L15 16l2.3-.8L18 13ZM6 13l.7 2.2L9 16l-2.3.8L6 19l-.7-2.2L3 16l2.3-.8L6 13Z" /></>,
  success: <path d="m5 12 4 4L19 6" />,
};

export function Icon({ name, ...props }: IconProps): JSX.Element {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>{paths[name]}</svg>;
}
