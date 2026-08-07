import { SearchPalette } from '../../components/SearchPalette';

export const dynamic = 'force-dynamic';

export default function SearchPage() {
  return (
    <div className="q-page q-page--palette">
      <SearchPalette />
    </div>
  );
}
