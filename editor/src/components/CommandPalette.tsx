import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from './ui/command';

export interface CommandPaletteItem {
  id: string;
  label: string;
  group: string;
  keywords?: string[];
  hint?: string;
  onSelect: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: CommandPaletteItem[];
}

export function CommandPalette({ open, onOpenChange, items }: CommandPaletteProps) {
  const groups = Array.from(new Set(items.map((item) => item.group)));

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <Command>
        <CommandInput placeholder="Type a command or search..." />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          {groups.map((group) => (
            <CommandGroup key={group} heading={group}>
              {items
                .filter((item) => item.group === group)
                .map((item) => (
                  <CommandItem
                    key={item.id}
                    value={[item.label, item.group, ...(item.keywords ?? [])].join(' ')}
                    onSelect={() => {
                      item.onSelect();
                      onOpenChange(false);
                    }}
                  >
                    <span className="truncate">{item.label}</span>
                    {item.hint && <CommandShortcut>{item.hint}</CommandShortcut>}
                  </CommandItem>
                ))}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
