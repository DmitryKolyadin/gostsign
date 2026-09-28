import { useRef, useState } from 'react';
import {
  FIELD_LABELS,
  PRESETS,
  parseStyle,
  resolveLines,
  type PresetId,
  type StampData,
  type StampStyle,
} from '@gostsign/core';
import { StampSvg } from './StampSvg';

interface Props {
  style: StampStyle;
  onChange: (s: StampStyle) => void;
  stampData: StampData | null;
}

const MAX_IMAGE_SIDE = 600;
const MAX_IMAGE_BYTES = 400 * 1024;

export function StampConfigurator({ style, onChange, stampData }: Props) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);

  // любая ручная правка превращает пресет в «свой»
  const edit = (patch: Partial<StampStyle>) => onChange({ ...style, ...patch, preset: 'custom' });

  const moveField = (i: number, dir: -1 | 1) => {
    const fields = [...style.fields];
    const j = i + dir;
    if (j < 0 || j >= fields.length) return;
    [fields[i], fields[j]] = [fields[j], fields[i]];
    edit({ fields });
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(style, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'gostsign-stamp.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const importJson = async (file: File) => {
    setError(null);
    try {
      onChange(parseStyle(JSON.parse(await file.text())));
    } catch (e) {
      setError(e instanceof SyntaxError ? 'Файл не является корректным JSON' : (e as Error).message);
    }
  };

  const loadImage = async (file: File) => {
    setError(null);
    try {
      const bmp = await createImageBitmap(file);
      const k = Math.min(1, MAX_IMAGE_SIDE / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bmp.width * k);
      canvas.height = Math.round(bmp.height * k);
      canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/png');
      if (dataUrl.length * 0.75 > MAX_IMAGE_BYTES) {
        throw new Error('Картинка слишком тяжёлая — возьмите PNG/JPG попроще (до 400 КБ после сжатия)');
      }
      edit({
        image: { dataUrl, width: canvas.width, height: canvas.height, ratio: style.image?.ratio ?? 0.3 },
        layout: style.layout === 'text' ? 'image-left' : style.layout,
      });
    } catch (e) {
      setError((e as Error).message || 'Не удалось прочитать изображение');
    }
  };

  const sampleDate = new Date();

  return (
    <div className="panel stampcfg">
      <button className="stampcfg__head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <h2 className="panel__title">Внешний вид штампа</h2>
        <span className="muted">
          {style.preset === 'custom' ? 'свой' : PRESETS[style.preset].name} {open ? '▴' : '▾'}
        </span>
      </button>

      {open && (
        <>
          <div className="stampcfg__presets">
            {(Object.keys(PRESETS) as PresetId[]).map((id) => {
              const p = PRESETS[id];
              return (
                <button
                  key={id}
                  className={'preset' + (style.preset === id ? ' preset--on' : '')}
                  onClick={() => onChange({ ...p.style, image: style.image, extraLines: style.extraLines })}
                >
                  <StampSvg
                    className="preset__svg"
                    style={p.style}
                    lines={resolveLines(p.style, stampData, sampleDate)}
                    width={p.size[0]}
                    height={p.size[1]}
                  />
                  <span>{p.name}</span>
                </button>
              );
            })}
          </div>

          <fieldset className="stampcfg__group">
            <legend>Цвета</legend>
            <div className="stampcfg__grid">
              <ColorInput label="Акцент" value={style.colors.accent} onChange={(v) => edit({ colors: { ...style.colors, accent: v } })} />
              <ColorInput label="Заголовок" value={style.colors.title} onChange={(v) => edit({ colors: { ...style.colors, title: v } })} />
              <ColorInput label="Текст" value={style.colors.text} onChange={(v) => edit({ colors: { ...style.colors, text: v } })} />
              <label className="stampcfg__field">
                <span>Фон</span>
                <span className="row">
                  <input
                    type="color"
                    disabled={style.colors.background === null}
                    value={style.colors.background ?? '#ffffff'}
                    onChange={(e) => edit({ colors: { ...style.colors, background: e.target.value } })}
                  />
                  <label className="toggle toggle--inline">
                    <input
                      type="checkbox"
                      checked={style.colors.background === null}
                      onChange={(e) =>
                        edit({ colors: { ...style.colors, background: e.target.checked ? null : '#ffffff' } })
                      }
                    />
                    <span>прозрачный</span>
                  </label>
                </span>
              </label>
            </div>
          </fieldset>

          <fieldset className="stampcfg__group">
            <legend>Рамка</legend>
            <div className="stampcfg__grid">
              <RangeInput label="Толщина" min={0} max={3} step={0.1} value={style.border.width} unit="пт"
                onChange={(v) => edit({ border: { ...style.border, width: v } })} />
              <RangeInput label="Скругление" min={0} max={12} step={0.5} value={style.border.radius} unit="пт"
                onChange={(v) => edit({ border: { ...style.border, radius: v } })} />
            </div>
            <label className="toggle">
              <input type="checkbox" checked={style.border.double}
                onChange={(e) => edit({ border: { ...style.border, double: e.target.checked } })} />
              <span>Двойная рамка</span>
            </label>
            <label className="toggle">
              <input type="checkbox" checked={style.border.accentBar}
                onChange={(e) => edit({ border: { ...style.border, accentBar: e.target.checked } })} />
              <span>Полоса слева</span>
            </label>
          </fieldset>

          <fieldset className="stampcfg__group">
            <legend>Текст</legend>
            <div className="stampcfg__grid">
              <label className="stampcfg__field">
                <span>Выравнивание</span>
                <select className="input" value={style.align}
                  onChange={(e) => edit({ align: e.target.value as StampStyle['align'] })}>
                  <option value="left">по левому краю</option>
                  <option value="center">по центру</option>
                </select>
              </label>
              <RangeInput label="Макс. кегль" min={6} max={14} step={0.5} value={style.maxFontSize} unit="пт"
                onChange={(v) => edit({ maxFontSize: v })} />
            </div>
            <label className="stampcfg__field">
              <span>Заголовок</span>
              <input className="input" value={style.titleText} maxLength={120}
                onChange={(e) => edit({ titleText: e.target.value })} />
            </label>
            <ul className="stampcfg__fields">
              {style.fields.map((f, i) => (
                <li key={f.id}>
                  <label className="toggle toggle--inline">
                    <input
                      type="checkbox"
                      checked={f.enabled}
                      onChange={(e) =>
                        edit({ fields: style.fields.map((x) => (x.id === f.id ? { ...x, enabled: e.target.checked } : x)) })
                      }
                    />
                    <span>{FIELD_LABELS[f.id]}</span>
                  </label>
                  <span className="stampcfg__order">
                    <button className="btn btn--ghost btn--icon" disabled={i === 0} onClick={() => moveField(i, -1)} aria-label="Выше">↑</button>
                    <button className="btn btn--ghost btn--icon" disabled={i === style.fields.length - 1} onClick={() => moveField(i, 1)} aria-label="Ниже">↓</button>
                  </span>
                </li>
              ))}
            </ul>
            <label className="stampcfg__field">
              <span>Дополнительные строки (должность, организация — до 4 строк)</span>
              <textarea
                className="input"
                rows={2}
                value={style.extraLines.join('\n')}
                onChange={(e) => {
                  const extraLines = e.target.value.split('\n').slice(0, 4);
                  const fields = style.fields.map((f) =>
                    f.id === 'extra' && extraLines.some((l) => l.trim()) ? { ...f, enabled: true } : f,
                  );
                  edit({ extraLines, fields });
                }}
              />
            </label>
          </fieldset>

          <fieldset className="stampcfg__group">
            <legend>Логотип или роспись</legend>
            <input ref={imageRef} type="file" accept="image/png,image/jpeg" hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void loadImage(f);
              }} />
            <div className="row">
              <button className="btn btn--ghost" onClick={() => imageRef.current?.click()}>
                {style.image ? 'Заменить картинку' : 'Загрузить PNG/JPG'}
              </button>
              {style.image && (
                <button className="btn btn--ghost" onClick={() => edit({ image: null, layout: 'text' })}>
                  Убрать
                </button>
              )}
            </div>
            {style.image && (
              <div className="stampcfg__grid">
                <label className="stampcfg__field">
                  <span>Раскладка</span>
                  <select className="input" value={style.layout}
                    onChange={(e) => edit({ layout: e.target.value as StampStyle['layout'] })}>
                    <option value="image-left">картинка слева</option>
                    <option value="image-top">картинка сверху</option>
                    <option value="text">без картинки</option>
                  </select>
                </label>
                <RangeInput label="Размер картинки" min={0.1} max={0.7} step={0.05} value={style.image.ratio}
                  format={(v) => `${Math.round(v * 100)}%`}
                  onChange={(v) => edit({ image: { ...style.image!, ratio: v } })} />
              </div>
            )}
          </fieldset>

          <div className="row">
            <button className="btn btn--ghost" onClick={() => onChange(PRESETS.classic.style)}>Сбросить</button>
            <button className="btn btn--ghost" onClick={exportJson}>Экспорт JSON</button>
            <button className="btn btn--ghost" onClick={() => importRef.current?.click()}>Импорт JSON</button>
            <input ref={importRef} type="file" accept="application/json,.json" hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void importJson(f);
              }} />
          </div>
          {error && <div className="notice notice--error">{error}</div>}
          <p className="muted">Настройки сохраняются в этом браузере.</p>
        </>
      )}
    </div>
  );
}

function ColorInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="stampcfg__field">
      <span>{label}</span>
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function RangeInput(props: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  unit?: string;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const shown = props.format ? props.format(props.value) : `${props.value} ${props.unit ?? ''}`;
  return (
    <label className="stampcfg__field">
      <span>
        {props.label}: <b>{shown}</b>
      </span>
      <input type="range" min={props.min} max={props.max} step={props.step} value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))} />
    </label>
  );
}
