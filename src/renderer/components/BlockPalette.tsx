import { Plus } from 'lucide-react';
const blocks = [
  ['Alinea', '<p>Nieuwe tekst</p>'],
  ['Kop', '<h2>Nieuwe kop</h2>'],
  ['Link', '<a href="#">Nieuwe link</a>'],
  ['Afbeelding', '<img src="" alt="Beschrijving">'],
  ['Knop', '<button type="button">Knop</button>'],
  ['Container', '<div class="container"></div>'],
  ['Kolommen', '<div class="columns" style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem"><div><p>Kolom 1</p></div><div><p>Kolom 2</p></div></div>'],
  ['Flex', '<div class="flex-container" style="display: flex; gap: 1rem"><div>Item 1</div><div>Item 2</div></div>'],
  ['Grid', '<div class="grid-container" style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1rem"><div>Item 1</div><div>Item 2</div><div>Item 3</div></div>'],
  ['Navigatie', '<nav aria-label="Navigatie"><a href="#">Home</a></nav>'],
  ['Tabel', '<table><thead><tr><th>Kolom 1</th><th>Kolom 2</th></tr></thead><tbody><tr><td>Cel 1</td><td>Cel 2</td></tr></tbody></table>'],
  ['Formulier', '<form><label>Naam <input type="text" name="naam"></label><button type="submit">Verzenden</button></form>']
] as const;
export function BlockPalette({ disabled, onInsert }: { disabled: boolean; onInsert: (html: string) => void }) {
  return <div className="block-palette"><div className="section-label">BLOK INVOEGEN</div><p className="muted small">Voeg een statisch blok toe binnen het geselecteerde element.</p><div>{blocks.map(([name, html]) => <button key={name} disabled={disabled} onClick={() => onInsert(html)}><Plus size={11}/>{name}</button>)}</div></div>;
}
