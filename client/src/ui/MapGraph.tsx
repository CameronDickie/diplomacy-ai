import { useEffect, useRef, useState } from 'react';
import type { GameState, TerritoryId, Unit } from '@diplomacy/shared';
import { POWER_COLORS, TERRITORY_BY_ID, territoryName } from '../lib/game.js';

interface Props {
  gameState: GameState | null;
  selectedTerritory: TerritoryId | null;
  validTargets: TerritoryId[];
  onSelectTerritory: (territory: TerritoryId) => void;
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const SVG_TO_INTERNAL: Record<string, TerritoryId> = {
  mid: 'MAO',
  nat: 'NAO',
  nrg: 'NWG',
  nwy: 'NOR',
};
const INTERNAL_TO_SVG: Record<TerritoryId, string> = {
  MAO: 'mid',
  NAO: 'nat',
  NWG: 'nrg',
  NOR: 'nwy',
};
const MIN_ZOOM = 0.75;
const MAX_ZOOM = 2.5;
const ZOOM_STEP = 0.25;

export function MapGraph({
  gameState,
  selectedTerritory,
  validTargets,
  onSelectTerritory,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    scrollLeft: number;
    scrollTop: number;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const [markup, setMarkup] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/standard-map.svg', { signal: controller.signal })
      .then(response => {
        if (!response.ok) throw new Error(`Map request failed (${response.status})`);
        return response.text();
      })
      .then(setMarkup)
      .catch(error => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setLoadError(error instanceof Error ? error.message : 'Unable to load map');
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    const svg = container?.querySelector('svg');
    if (!container || !svg || !markup) return;

    svg.classList.add('diplomacy-map');
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Interactive Diplomacy board');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    const provinces = svg.querySelector<SVGGElement>('#provinces');
    if (provinces) {
      provinces.style.display = 'inline';
      for (const shape of Array.from(provinces.children)) {
        if (!(shape instanceof SVGElement) || !shape.id) continue;
        if (shape.id.includes('/')) {
          shape.style.pointerEvents = 'none';
          continue;
        }
        const territory = toInternalTerritory(shape.id);
        const definition = TERRITORY_BY_ID[territory];
        if (!definition) continue;

        const territoryState = gameState?.territories[territory];
        const color = territoryState?.owner
          ? POWER_COLORS[territoryState.owner]
          : definition.type === 'SEA'
            ? '#32647d'
            : '#b5a98e';

        shape.dataset.territory = territory;
        shape.classList.add('province-shape');
        shape.classList.toggle('selected', territory === selectedTerritory);
        shape.classList.toggle('valid-target', validTargets.includes(territory));
        shape.style.setProperty('fill', color, 'important');
        shape.style.setProperty(
          'fill-opacity',
          definition.type === 'SEA' ? '0.32' : territoryState?.owner ? '0.64' : '0.46',
          'important'
        );
        shape.style.setProperty('stroke', '#17232b', 'important');
        shape.style.setProperty('stroke-width', '1.4', 'important');
      }
    }

    const supplyCenters = svg.querySelector<SVGGElement>('#supply-centers');
    if (supplyCenters) {
      supplyCenters.style.display = 'inline';
      supplyCenters.style.pointerEvents = 'none';
    }

    const names = svg.querySelector<SVGGElement>('#names');
    if (names) names.style.pointerEvents = 'none';

    const provinceCenters = svg.querySelector<SVGGElement>('#province-centers');
    if (provinceCenters) {
      provinceCenters.style.display = 'inline';
      provinceCenters.style.visibility = 'hidden';
    }

    renderUnits(svg, gameState?.units ?? []);

    const handleClick = (event: Event) => {
      if (suppressClickRef.current) {
        event.preventDefault();
        event.stopPropagation();
        suppressClickRef.current = false;
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) return;
      const province = target.closest<SVGElement>('[data-territory]');
      const territory = province?.dataset.territory;
      if (territory) onSelectTerritory(territory);
    };
    svg.addEventListener('click', handleClick);
    return () => svg.removeEventListener('click', handleClick);
  }, [gameState, markup, onSelectTerritory, selectedTerritory, validTargets]);

  if (loadError) {
    return <div className="map-message">Map unavailable: {loadError}</div>;
  }
  if (!markup) {
    return <div className="map-message">Loading board...</div>;
  }

  function changeZoom(delta: number) {
    setZoom(current => clampZoom(current + delta));
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const container = containerRef.current;
    if (!container) return;
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      scrollLeft: container.scrollLeft,
      scrollTop: container.scrollTop,
      moved: false,
    };
    container.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const container = containerRef.current;
    if (!drag || !container || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) > 4) {
      drag.moved = true;
      container.classList.add('dragging');
    }
    if (!drag.moved) return;
    container.scrollLeft = drag.scrollLeft - dx;
    container.scrollTop = drag.scrollTop - dy;
  }

  function handlePointerEnd(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const container = containerRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    suppressClickRef.current = drag.moved;
    dragRef.current = null;
    container?.classList.remove('dragging');
    if (container?.hasPointerCapture(event.pointerId)) {
      container.releasePointerCapture(event.pointerId);
    }
  }

  return (
    <div className="map-frame">
      <div className="map-controls" aria-label="Map zoom controls">
        <button
          type="button"
          aria-label="Zoom out"
          onClick={() => changeZoom(-ZOOM_STEP)}
          disabled={zoom <= MIN_ZOOM}
        >
          -
        </button>
        <button type="button" onClick={() => setZoom(1)} aria-label="Reset map zoom">
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          aria-label="Zoom in"
          onClick={() => changeZoom(ZOOM_STEP)}
          disabled={zoom >= MAX_ZOOM}
        >
          +
        </button>
      </div>
      <div
        className="map-viewport"
        ref={containerRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
      >
        <div
          className="map-canvas"
          style={{ width: `${zoom * 100}%`, height: `${zoom * 100}%` }}
          dangerouslySetInnerHTML={{ __html: markup }}
        />
      </div>
    </div>
  );
}

function renderUnits(svg: SVGSVGElement, units: Unit[]): void {
  const layer = svg.querySelector<SVGGElement>('#units');
  if (!layer) return;
  layer.replaceChildren();

  for (const unit of units) {
    const anchorId = `${unitAnchor(unit)}Center`;
    const anchor = svg.getElementById(anchorId);
    if (!(anchor instanceof SVGGraphicsElement)) continue;
    const box = anchor.getBBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;

    const marker = document.createElementNS(SVG_NAMESPACE, 'g');
    marker.classList.add('unit-marker');
    if (unit.mustRetreat) marker.classList.add('must-retreat');
    marker.setAttribute('transform', `translate(${x} ${y})`);
    marker.style.setProperty('--unit-color', POWER_COLORS[unit.power]);
    marker.setAttribute(
      'aria-label',
      `${unit.power} ${unit.type.toLowerCase()} in ${territoryName(unit.territory)}`
    );

    const body = document.createElementNS(SVG_NAMESPACE, 'rect');
    body.setAttribute('x', '-18');
    body.setAttribute('y', '-13');
    body.setAttribute('width', '36');
    body.setAttribute('height', '26');
    body.setAttribute('rx', unit.type === 'FLEET' ? '13' : '5');

    const label = document.createElementNS(SVG_NAMESPACE, 'text');
    label.setAttribute('x', '0');
    label.setAttribute('y', '6');
    label.textContent = unit.type === 'FLEET' ? 'F' : 'A';

    marker.append(body, label);
    layer.append(marker);
  }
}

function unitAnchor(unit: Unit): string {
  const province = INTERNAL_TO_SVG[unit.territory] ?? unit.territory.toLowerCase();
  if (!unit.coast) return province;
  const coast = {
    NORTH: 'nc',
    SOUTH: 'sc',
    EAST: 'ec',
    WEST: 'wc',
  }[unit.coast];
  return `${province}/${coast}`;
}

function toInternalTerritory(svgId: string): TerritoryId {
  return SVG_TO_INTERNAL[svgId] ?? svgId.toUpperCase();
}

function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}
