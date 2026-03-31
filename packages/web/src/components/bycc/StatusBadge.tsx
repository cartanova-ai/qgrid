interface StatusBadgeProps {
  active: boolean;
}

export function StatusBadge({ active }: StatusBadgeProps) {
  return (
    <span
      className={`px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider rounded ${
        active ? "bg-sage-50 text-sage-600" : "bg-red-50 text-red-500"
      }`}
    >
      {active ? "Active" : "Exhausted"}
    </span>
  );
}
