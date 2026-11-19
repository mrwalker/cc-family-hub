# /context

Review and manage accumulated context items in `workspace/context/`.

## What this does

Reads all unconsumed context items (notes, links, todos, shopping items) and presents a summary. You can then:
- Mark specific items as consumed (so they don't re-appear in future planning runs)
- Delete items that are no longer relevant
- View items by type or member

## Steps

1. Load all context items from `workspace/context/` using the loader
2. Show a grouped summary:
   - **Notes** — free-form notes submitted by family members
   - **Links** — flagged URLs with context
   - **Todos** — items from Apple Reminders or other todo sources
   - **Shopping** — shopping list items
3. Ask the user what they'd like to do: mark as consumed, delete, or just review
4. Make the requested changes to the YAML files

## Finding context files

Context items are individual YAML files in subdirectories:
- `workspace/context/notes/`
- `workspace/context/links/`
- `workspace/context/todos/`
- `workspace/context/shopping/`

To mark an item as consumed, set `consumed: true` in the YAML file.
