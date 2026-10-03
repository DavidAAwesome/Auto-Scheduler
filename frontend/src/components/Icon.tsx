export type IconName =
  | "home"
  | "tasks"
  | "assistant"
  | "analytics"
  | "calendar"
  | "profile"
  | "settings"
  | "menu"
  | "close"
  | "arrow"
  | "logout";
const paths: Record<IconName, string> = {
  home: "M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z",
  tasks: "M8 3h8M8 5H5v16h14V5h-3M8 12l3 3 5-6",
  assistant: "m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4Z",
  analytics: "M5 20V11m7 9V4m7 16V8",
  calendar: "M4 5h16v16H4ZM4 10h16M8 3v4m8-4v4",
  profile: "M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a8 8 0 0 1 16 0v2",
  settings:
    "m9 3-1 3-3 1-2 5 2 5 3 1 1 3h6l1-3 3-1 2-5-2-5-3-1-1-3ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
  menu: "M4 6h16M4 12h16M4 18h16",
  close: "m6 6 12 12M6 18 18 6",
  arrow: "M4 12h16m-6-6 6 6-6 6",
  logout: "M9 4H4v16h5m-1-8h13m-5-5 5 5-5 5",
};
export default function Icon({
  name,
  size = 21,
}: {
  name: IconName;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
