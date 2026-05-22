'use client';

import { useState } from 'react';
import type { BrandIngredients, Product } from '@video-factory/contracts';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';

type Placement = BrandIngredients['logoPlacement'];
type Asset = BrandIngredients['assets'][number];

export interface IngredientsEditorProps {
  brandId: string;
  initialIngredients: BrandIngredients;
  products: Product[];
}

export function IngredientsEditor({
  brandId,
  initialIngredients,
  products,
}: IngredientsEditorProps) {
  const [ingredients, setIngredients] = useState<BrandIngredients>(initialIngredients);
  const [savedMsg, setSavedMsg] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [isSaving, setIsSaving] = useState(false);

  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoDescription, setLogoDescription] = useState(ingredients.logoDescription ?? '');
  const [logoPlacement, setLogoPlacement] = useState<Placement>(
    ingredients.logoPlacement ?? 'last-scene',
  );

  const [assetFile, setAssetFile] = useState<File | null>(null);
  const [assetKind, setAssetKind] = useState<Asset['kind']>('product-shot');
  const [assetDescription, setAssetDescription] = useState('');

  const [mustIncludeText, setMustIncludeText] = useState(ingredients.mustInclude.join('\n'));
  const [mustAvoidText, setMustAvoidText] = useState(ingredients.mustAvoid.join('\n'));
  const [paletteRows, setPaletteRows] = useState(
    ingredients.colorPalette.length > 0
      ? ingredients.colorPalette
      : [{ name: '', hex: '#000000', usage: '' }],
  );

  function flash(success: string) {
    setSavedMsg(success);
    setErrorMsg('');
    setTimeout(() => setSavedMsg(''), 2500);
  }
  function flashError(msg: string) {
    setErrorMsg(msg);
    setSavedMsg('');
  }

  async function uploadLogo() {
    if (!logoFile) {
      flashError('Selecciona un archivo de logo');
      return;
    }
    setIsSaving(true);
    try {
      const form = new FormData();
      form.append('file', logoFile);
      if (logoDescription.trim()) form.append('description', logoDescription.trim());
      form.append('placement', logoPlacement);
      const res = await fetch(`/api/brands/${brandId}/logo`, { method: 'POST', body: form });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setIngredients((prev) => ({
        ...prev,
        logoPath: data.logoPath,
        logoDescription: data.description,
        logoPlacement: data.placement,
      }));
      setLogoFile(null);
      flash('Logo guardado');
    } catch (e) {
      flashError((e as Error).message);
    } finally {
      setIsSaving(false);
    }
  }

  async function uploadAsset() {
    if (!assetFile || !assetDescription.trim()) {
      flashError('Archivo y descripción son requeridos');
      return;
    }
    setIsSaving(true);
    try {
      const form = new FormData();
      form.append('file', assetFile);
      form.append('kind', assetKind);
      form.append('description', assetDescription.trim());
      const res = await fetch(`/api/brands/${brandId}/assets`, { method: 'POST', body: form });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setIngredients((prev) => ({ ...prev, assets: data.assets }));
      setAssetFile(null);
      setAssetDescription('');
      flash('Asset agregado');
    } catch (e) {
      flashError((e as Error).message);
    } finally {
      setIsSaving(false);
    }
  }

  async function deleteAsset(assetId: string) {
    if (!confirm('¿Borrar este asset?')) return;
    setIsSaving(true);
    try {
      const res = await fetch(`/api/brands/${brandId}/assets/${assetId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setIngredients((prev) => ({ ...prev, assets: data.assets }));
      flash('Asset borrado');
    } catch (e) {
      flashError((e as Error).message);
    } finally {
      setIsSaving(false);
    }
  }

  async function saveRulesAndPalette() {
    setIsSaving(true);
    try {
      const mustInclude = mustIncludeText
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      const mustAvoid = mustAvoidText
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      const colorPalette = paletteRows
        .filter((r) => r.name.trim() && /^#[0-9a-fA-F]{6}$/.test(r.hex))
        .map((r) => ({
          name: r.name.trim(),
          hex: r.hex,
          usage: r.usage?.trim() || undefined,
        }));

      const res = await fetch(`/api/brands/${brandId}/ingredients`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mustInclude, mustAvoid, colorPalette }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setIngredients((prev) => ({
        ...prev,
        mustInclude: data.ingredients.mustInclude,
        mustAvoid: data.ingredients.mustAvoid,
        colorPalette: data.ingredients.colorPalette,
      }));
      flash('Reglas y paleta guardadas');
    } catch (e) {
      flashError((e as Error).message);
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      {savedMsg && (
        <div className="rounded-md bg-green-500/10 px-3 py-2 text-sm text-green-700 dark:text-green-400">
          ✓ {savedMsg}
        </div>
      )}
      {errorMsg && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {errorMsg}
        </div>
      )}

      {/* LOGO */}
      <Card>
        <CardContent className="space-y-4 pt-6">
          <div>
            <h2 className="text-base font-semibold">Logo de la marca</h2>
            <p className="text-xs text-muted-foreground">
              PNG/JPG/WebP/SVG. La IA puede mencionarlo en prompts y Remotion lo puede overlay-ar.
            </p>
          </div>
          {ingredients.logoPath && (
            <div className="flex items-center gap-3 rounded-md border border-dashed p-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/brands/${brandId}/file?which=logo`}
                alt="Logo actual"
                className="h-20 w-20 rounded-md object-contain bg-muted"
              />
              <div className="text-xs text-muted-foreground">
                <p>Logo actual cargado.</p>
                <p className="font-mono break-all">{ingredients.logoPath}</p>
              </div>
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="logo-file">Archivo</Label>
              <Input
                id="logo-file"
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                onChange={(e) => setLogoFile(e.target.files?.[0] ?? null)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="logo-placement">Cuándo aparece</Label>
              <select
                id="logo-placement"
                value={logoPlacement}
                onChange={(e) => setLogoPlacement(e.target.value as Placement)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="last-scene">Solo en la última escena</option>
                <option value="all-scenes">En todas las escenas (overlay)</option>
                <option value="product-scenes">Solo en escenas con producto</option>
                <option value="never">No usar automáticamente</option>
              </select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="logo-description">Descripción para la IA</Label>
            <Textarea
              id="logo-description"
              value={logoDescription}
              onChange={(e) => setLogoDescription(e.target.value)}
              placeholder="Ej: Texto 'VITALY' amarillo (#FFE600) en tipografía sans-serif redondeada sobre fondo blanco."
              className="min-h-[60px]"
            />
          </div>
          <Button onClick={uploadLogo} disabled={isSaving || !logoFile}>
            Guardar logo
          </Button>
        </CardContent>
      </Card>

      {/* ASSETS */}
      <Card>
        <CardContent className="space-y-4 pt-6">
          <div>
            <h2 className="text-base font-semibold">Assets visuales (ingredients)</h2>
            <p className="text-xs text-muted-foreground">
              Sube fotos de productos, packaging, mockups. Cada uno necesita una
              descripción para que la IA sepa cuándo usarlo.
            </p>
          </div>

          {ingredients.assets.length > 0 && (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {ingredients.assets.map((a) => (
                <div key={a.id} className="space-y-1.5 rounded-md border p-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/brands/${brandId}/file?which=asset&assetId=${a.id}`}
                    alt={a.description}
                    className="aspect-square w-full rounded object-contain bg-muted"
                  />
                  <p className="text-xs font-medium">{a.kind}</p>
                  <p className="text-xs text-muted-foreground line-clamp-2">{a.description}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => deleteAsset(a.id)}
                    disabled={isSaving}
                    className="w-full"
                  >
                    Borrar
                  </Button>
                </div>
              ))}
            </div>
          )}

          <div className="rounded-md border border-dashed p-3 space-y-3">
            <p className="text-xs font-medium">Agregar nuevo asset</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="asset-file">Archivo</Label>
                <Input
                  id="asset-file"
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(e) => setAssetFile(e.target.files?.[0] ?? null)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="asset-kind">Tipo</Label>
                <select
                  id="asset-kind"
                  value={assetKind}
                  onChange={(e) => setAssetKind(e.target.value as Asset['kind'])}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="product-shot">Foto de producto</option>
                  <option value="packaging">Empaque / packaging</option>
                  <option value="mockup">Mockup</option>
                  <option value="lifestyle">Lifestyle</option>
                  <option value="icon">Ícono</option>
                  <option value="other">Otro</option>
                </select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="asset-description">Descripción</Label>
              <Textarea
                id="asset-description"
                value={assetDescription}
                onChange={(e) => setAssetDescription(e.target.value)}
                placeholder="Ej: Frasco gotero ámbar de 30ml, etiqueta amarilla con texto 'VITALY GOTAS', tapa con cuentagotas plástico."
                className="min-h-[60px]"
              />
            </div>
            <Button
              onClick={uploadAsset}
              disabled={isSaving || !assetFile || !assetDescription.trim()}
            >
              Agregar asset
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* PRODUCTOS CONFIGURADOS (read-only por ahora) */}
      {products.length > 0 && (
        <Card>
          <CardContent className="space-y-2 pt-6">
            <h2 className="text-base font-semibold">Productos declarados</h2>
            <p className="text-xs text-muted-foreground">
              Definidos en <code className="text-xs">brand.json</code> · solo lectura por ahora.
            </p>
            <ul className="space-y-1.5">
              {products.map((p) => (
                <li key={p.id} className="rounded-md bg-muted/30 px-3 py-2 text-sm">
                  <p className="font-medium">{p.name}</p>
                  <p className="text-xs text-muted-foreground">{p.description}</p>
                  {p.dimensions && (
                    <p className="text-xs text-muted-foreground">Dimensiones: {p.dimensions}</p>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* REGLAS + PALETA */}
      <Card>
        <CardContent className="space-y-4 pt-6">
          <h2 className="text-base font-semibold">Reglas de uso + paleta</h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="must-include">Siempre incluir (una por línea)</Label>
              <Textarea
                id="must-include"
                value={mustIncludeText}
                onChange={(e) => setMustIncludeText(e.target.value)}
                placeholder={'Disponible en Farmacias\nGarantía 30 días'}
                className="min-h-[90px]"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="must-avoid">Nunca incluir (una por línea)</Label>
              <Textarea
                id="must-avoid"
                value={mustAvoidText}
                onChange={(e) => setMustAvoidText(e.target.value)}
                placeholder={'Claims médicos absolutos\nComparaciones con competencia'}
                className="min-h-[90px]"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Paleta de colores</Label>
            {paletteRows.map((row, idx) => (
              <div key={idx} className="grid grid-cols-1 md:grid-cols-[140px_120px_1fr_60px] gap-2">
                <Input
                  placeholder="Nombre (ej: amarillo Vitaly)"
                  value={row.name}
                  onChange={(e) => {
                    const next = [...paletteRows];
                    next[idx] = { ...row, name: e.target.value };
                    setPaletteRows(next);
                  }}
                />
                <Input
                  type="text"
                  placeholder="#FFE600"
                  value={row.hex}
                  onChange={(e) => {
                    const next = [...paletteRows];
                    next[idx] = { ...row, hex: e.target.value };
                    setPaletteRows(next);
                  }}
                />
                <Input
                  placeholder="Uso (ej: subtítulos)"
                  value={row.usage ?? ''}
                  onChange={(e) => {
                    const next = [...paletteRows];
                    next[idx] = { ...row, usage: e.target.value };
                    setPaletteRows(next);
                  }}
                />
                <Button
                  variant="outline"
                  onClick={() => setPaletteRows(paletteRows.filter((_, i) => i !== idx))}
                  disabled={paletteRows.length <= 1}
                >
                  ×
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPaletteRows([...paletteRows, { name: '', hex: '#000000', usage: '' }])}
            >
              + Agregar color
            </Button>
          </div>

          <Button onClick={saveRulesAndPalette} disabled={isSaving}>
            Guardar reglas y paleta
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
