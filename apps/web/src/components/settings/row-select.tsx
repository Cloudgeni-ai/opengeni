import { SelectMenu, type SelectMenuProps } from "@opengeni/react/ui/select-menu";
import { useSettingRowField } from "@opengeni/react/ui/setting-row";

/**
 * A 32px menu select inside a SettingRow, named by the row's label and
 * described by its description (SelectMenu only reads Field context).
 */
export function RowSelect<V extends string>(props: SelectMenuProps<V>) {
  const field = useSettingRowField();
  return (
    <SelectMenu
      size="sm"
      aria-labelledby={field?.labelId}
      aria-describedby={field?.describedBy}
      {...props}
    />
  );
}
