import { cn } from "@/lib/utils";

export const filterMenuContentClass = "border-border bg-card p-2 text-card-foreground shadow-[var(--menu-shadow)]";
export const filterMenuLabelClass = "px-2 py-1.5 text-[13px] font-bold text-foreground";
export const filterMenuSeparatorClass = "my-1";
export const filterMenuSubTriggerClass = "h-9 rounded-[9px] px-2 text-[13px] font-medium focus:bg-[var(--menu-selection)] data-open:bg-[var(--menu-selection)]";
export const filterMenuItemClass = "h-9 rounded-[9px] px-2 text-[13px] font-medium focus:bg-[var(--menu-selection)]";

export function filterMenuCheckboxItemClass(isChecked: boolean, className?: string): string {
  return cn(
    "h-9 rounded-[9px] py-1 pl-8 pr-2 text-[13px] font-medium",
    "focus:bg-[var(--menu-selection)]",
    "[&_[data-slot=dropdown-menu-checkbox-item-indicator]]:right-auto",
    "[&_[data-slot=dropdown-menu-checkbox-item-indicator]]:left-2",
    "[&_[data-slot=dropdown-menu-checkbox-item-indicator]]:size-5",
    "[&_[data-slot=dropdown-menu-checkbox-item-indicator]]:rounded-[6px]",
    "[&_[data-slot=dropdown-menu-checkbox-item-indicator]]:border",
    "[&_[data-slot=dropdown-menu-checkbox-item-indicator]]:border-border",
    "[&_[data-slot=dropdown-menu-checkbox-item-indicator]]:bg-background",
    "[&_[data-slot=dropdown-menu-checkbox-item-indicator]]:text-white",
    "[&_[data-slot=dropdown-menu-checkbox-item-indicator]_svg]:size-3.5",
    isChecked && [
      "bg-[var(--menu-selection)]",
      "[&_[data-slot=dropdown-menu-checkbox-item-indicator]]:border-foreground",
      "[&_[data-slot=dropdown-menu-checkbox-item-indicator]]:bg-foreground",
    ],
    className,
  );
}
