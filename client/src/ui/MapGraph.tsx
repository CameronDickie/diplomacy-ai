import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Coast, GameState, Order, Power, TerritoryId, Unit } from '@diplomacy/shared';
import { POWER_COLORS, TERRITORY_BY_ID, territoryName } from '../lib/game.js';

interface Props {
  gameState: Pick<GameState, 'units' | 'territories'> | null;
  selectedTerritory: TerritoryId | null;
  selectedUnit: Unit | null;
  validTargets: TerritoryId[];
  pendingOrders: Order[];
  replayStandoffs?: TerritoryId[];
  unitAnimationFrom?: Unit[];
  unitAnimationKey?: string | null;
  /** Land provinces without a supply center, shaded lightly in the color of the power that last stood there. */
  heldTerritories?: Partial<Record<TerritoryId, Power>>;
  onSelectTerritory: (territory: TerritoryId, point?: { x: number; y: number }) => void;
  onClearSelection: () => void;
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
const MIN_ZOOM = 1;
const MAX_ZOOM = 3.5;
const ZOOM_STEP = 0.25;
const WHEEL_ZOOM_STEP = 0.1;
const SELECTED_UNIT_ZOOM = 2.15;

export function MapGraph({
  gameState,
  selectedTerritory,
  selectedUnit,
  validTargets,
  pendingOrders,
  replayStandoffs = [],
  unitAnimationFrom,
  unitAnimationKey,
  heldTerritories,
  onSelectTerritory,
  onClearSelection,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    scrollLeft: number;
    scrollTop: number;
    moved: boolean;
    clickTerritory: TerritoryId | null;
  } | null>(null);
  const consumedAnimationKeyRef = useRef<string | null>(null);
  const centeredUnitIdRef = useRef<string | null>(null);
  const pendingCenterRef = useRef<Point | null>(null);
  const [centerRequest, setCenterRequest] = useState(0);
  const [markup, setMarkup] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [hoveredTerritory, setHoveredTerritory] = useState<TerritoryId | null>(null);
  const orderTargeting = Boolean(selectedUnit);
  const pendingControlCount = gameState
    ? pendingSupplyControl(gameState).length
    : 0;

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
    svg.classList.toggle('order-targeting', orderTargeting);
    if (selectedUnit) {
      const activeColor = POWER_COLORS[selectedUnit.power];
      svg.style.setProperty('--active-power-color', activeColor);
      svg.style.setProperty('--active-power-inverse', inverseHexColor(activeColor));
    } else {
      svg.style.removeProperty('--active-power-color');
      svg.style.removeProperty('--active-power-inverse');
    }
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.setAttribute('role', 'img');
    const pendingControl = gameState ? pendingSupplyControl(gameState) : [];
    svg.setAttribute(
      'aria-label',
      pendingControl.length === 0
        ? 'Interactive Diplomacy board'
        : `Interactive Diplomacy board. Pending Fall control: ${pendingControl
            .map(item => `${territoryName(item.territory)} occupied by ${item.power}`)
            .join(', ')}`
    );
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.querySelectorAll('title').forEach(title => title.remove());

    const provinces = svg.querySelector<SVGGElement>('#provinces');
    const pendingByTerritory = new Map(
      pendingControl.map(item => [item.territory, item])
    );
    const dynamicPatterns = resetDynamicPatterns(svg);
    if (provinces) {
      provinces.style.display = 'inline';
      provinces.style.pointerEvents = 'auto';
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
        const pendingCapture = pendingByTerritory.get(territory);
        // A province without a center keeps a softened color of the power that last stood there.
        const held = !territoryState?.owner && !definition.isSupplyCenter ? heldTerritories?.[territory] : undefined;
        const color = territoryState?.owner
          ? POWER_COLORS[territoryState.owner]
          : held ? mixColors(POWER_COLORS[held], '#b5a98e', 0.45)
          : definition.type === 'SEA'
            ? '#32647d'
            : '#b5a98e';
        const fill = pendingCapture
          ? createControlPattern(
            dynamicPatterns,
            territory,
            color,
            POWER_COLORS[pendingCapture.power]
          )
          : color;

        shape.dataset.territory = territory;
        shape.style.pointerEvents = 'auto';
        shape.classList.add('province-shape');
        shape.classList.toggle('selected', territory === selectedTerritory);
        shape.classList.toggle('valid-target', validTargets.includes(territory));
        shape.classList.toggle(
          'invalid-target',
          orderTargeting && territory !== selectedTerritory && !validTargets.includes(territory)
        );
        shape.classList.toggle(
          'hovered-valid-target',
          orderTargeting && territory === hoveredTerritory && validTargets.includes(territory)
        );
        shape.classList.toggle(
          'hovered-invalid-target',
          orderTargeting && territory === hoveredTerritory && territory !== selectedTerritory && !validTargets.includes(territory)
        );
        shape.classList.toggle('replay-standoff', replayStandoffs.includes(territory));
        shape.classList.toggle('controlled-supply', Boolean(territoryState?.owner && definition.isSupplyCenter));
        shape.classList.toggle('controlled-non-supply', Boolean(territoryState?.owner && !definition.isSupplyCenter));
        shape.classList.toggle('pending-capture', Boolean(pendingCapture));
        shape.classList.toggle('held-non-supply', Boolean(held));
        shape.style.setProperty('fill', fill, 'important');
        shape.style.setProperty(
          'fill-opacity',
          definition.type === 'SEA'
            ? '0.32'
            : pendingCapture
              ? '0.82'
              : territoryState?.owner && definition.isSupplyCenter
                ? '0.72'
                : territoryState?.owner
                  ? '0.56'
                  : held
                    ? '0.5'
                    : '0.46',
          'important'
        );
        shape.style.setProperty('stroke', '#17232b', 'important');
        shape.style.setProperty('stroke-width', '1.4', 'important');
      }
    }

    const supplyCenters = svg.querySelector<SVGGElement>('#supply-centers');
    if (supplyCenters) {
      supplyCenters.style.display = 'inline';
      supplyCenters.style.visibility = 'hidden';
      supplyCenters.style.pointerEvents = 'none';
    }
    for (const group of Array.from(svg.querySelectorAll<SVGGElement>('g'))) {
      if (group.getAttribute('inkscape:label') === 'supply-centers foreground copy') {
        group.style.display = 'inline';
        group.style.pointerEvents = 'none';
      }
    }
    renderPendingSupplyControl(svg, pendingControl);

    const names = svg.querySelector<SVGGElement>('#names');
    if (names) names.style.pointerEvents = 'none';

    const provinceCenters = svg.querySelector<SVGGElement>('#province-centers');
    if (provinceCenters) {
      provinceCenters.style.display = 'inline';
      provinceCenters.style.visibility = 'hidden';
    }

    const shouldAnimateUnits = Boolean(
      unitAnimationKey && consumedAnimationKeyRef.current !== unitAnimationKey
    );
    renderUnits(
      svg,
      gameState?.units ?? [],
      selectedUnit?.id ?? null,
      shouldAnimateUnits ? unitAnimationFrom : undefined
    );
    if (shouldAnimateUnits) consumedAnimationKeyRef.current = unitAnimationKey ?? null;
    renderOrders(svg, pendingOrders);

    const handleKeyDown = (event: Event) => {
      if (!(event instanceof KeyboardEvent)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onClearSelection();
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key)) {
        const current = target.closest<SVGElement>('.unit-marker[data-territory]');
        if (!current) return;
        const markers = Array.from(svg.querySelectorAll<SVGElement>('.unit-marker[data-territory]'));
        const index = markers.indexOf(current);
        if (index < 0) return;
        const direction = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1;
        markers[(index + direction + markers.length) % markers.length]?.focus();
        event.preventDefault();
        return;
      }
      if (!['Enter', ' '].includes(event.key)) return;
      const marker = target.closest<SVGElement>('.unit-marker[data-territory]');
      const territory = marker?.dataset.territory;
      if (!territory) return;
      event.preventDefault();
      onSelectTerritory(territory);
    };
    svg.addEventListener('keydown', handleKeyDown);
    return () => {
      svg.removeEventListener('keydown', handleKeyDown);
    };
  }, [
    gameState,
    heldTerritories,
    markup,
    onClearSelection,
    onSelectTerritory,
    orderTargeting,
    hoveredTerritory,
    pendingOrders,
    replayStandoffs,
    selectedTerritory,
    selectedUnit?.id,
    selectedUnit?.power,
    unitAnimationFrom,
    unitAnimationKey,
    validTargets,
  ]);

  useEffect(() => {
    const container = containerRef.current;
    const svg = container?.querySelector('svg');
    if (!container || !(svg instanceof SVGSVGElement) || !markup) return;
    if (!selectedUnit) {
      // Letting go of a unit returns to the whole map, and lets the same unit be centred again later.
      if (centeredUnitIdRef.current !== null) {
        centeredUnitIdRef.current = null;
        setZoom(1);
      }
      return;
    }
    if (centeredUnitIdRef.current === selectedUnit.id) return;

    const center = territoryCenter(svg, selectedUnit.territory, selectedUnit.coast);
    if (!center) return;
    centeredUnitIdRef.current = selectedUnit.id;
    // The scroll is applied by the layout effect below, once the zoomed map has actually been laid out.
    pendingCenterRef.current = center;
    setZoom(current => Math.max(current, SELECTED_UNIT_ZOOM));
    setCenterRequest(request => request + 1);
  }, [markup, selectedUnit]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const svg = container?.querySelector('svg');
    const center = pendingCenterRef.current;
    if (!container || !(svg instanceof SVGSVGElement) || !center) return;
    pendingCenterRef.current = null;
    centerMapOnPoint(container, svg, center);
  }, [zoom, centerRequest]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleNativeWheel = (event: WheelEvent) => {
      event.preventDefault();
      // A trackpad's two-finger scroll and a mouse wheel both arrive as wheel events. A pinch sets
      // ctrlKey; a mouse wheel moves in whole notches on one axis. Anything else is a two-finger
      // scroll, which should move the map rather than zoom it.
      const notches = (event as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY;
      const mouseWheel = event.deltaMode !== 0 || (event.deltaX === 0 && notches !== undefined && notches !== 0 && Math.abs(notches) % 120 === 0);
      if (!event.ctrlKey && !event.metaKey && !mouseWheel) {
        container.scrollLeft += event.deltaX;
        container.scrollTop += event.deltaY;
        return;
      }
      if (event.deltaY === 0) return;

      const nextZoom = clampZoom(
        mouseWheel && !event.ctrlKey
          ? zoom + (event.deltaY < 0 ? WHEEL_ZOOM_STEP : -WHEEL_ZOOM_STEP)
          // A pinch reports many small steps; scale smoothly with how far the fingers moved.
          : zoom * Math.exp(-event.deltaY * 0.01)
      );
      if (nextZoom === zoom) return;

      const bounds = container.getBoundingClientRect();
      const pointerX = event.clientX - bounds.left;
      const pointerY = event.clientY - bounds.top;
      const contentX = container.scrollLeft + pointerX;
      const contentY = container.scrollTop + pointerY;
      const ratio = nextZoom / zoom;

      setZoom(nextZoom);
      requestAnimationFrame(() => {
        container.scrollLeft = contentX * ratio - pointerX;
        container.scrollTop = contentY * ratio - pointerY;
      });
    };

    container.addEventListener('wheel', handleNativeWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleNativeWheel);
  }, [zoom]);

  useEffect(() => {
    if (!orderTargeting) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClearSelection();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [onClearSelection, orderTargeting]);

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
    const clickTerritory =
      territoryFromClientPoint(event.clientX, event.clientY) ??
      nearestTerritoryFromClientPoint(container, event.clientX, event.clientY) ??
      territoryFromEventTarget(event.target);
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      scrollLeft: container.scrollLeft,
      scrollTop: container.scrollTop,
      moved: false,
      clickTerritory,
    };
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const container = containerRef.current;
    if (!container) return;
    const drag = dragRef.current?.pointerId === event.pointerId ? dragRef.current : null;
    const dx = drag ? event.clientX - drag.x : 0;
    const dy = drag ? event.clientY - drag.y : 0;
    // Dragging pans the map whether or not a unit is selected; the pointer is captured only once it
    // has really moved, so a plain click still reaches the territory under it.
    if (drag && !drag.moved && Math.hypot(dx, dy) > 4) {
      drag.moved = true;
      container.classList.add('dragging');
      container.setPointerCapture(event.pointerId);
    }
    if (!drag?.moved) {
      if (orderTargeting) {
        setHoveredTerritory(
          territoryFromClientPoint(event.clientX, event.clientY) ??
          nearestTerritoryFromClientPoint(container, event.clientX, event.clientY)
        );
      }
      return;
    }
    container.scrollLeft = drag.scrollLeft - dx;
    container.scrollTop = drag.scrollTop - dy;
  }

  function handlePointerEnd(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const container = containerRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    container?.classList.remove('dragging');
    if (container?.hasPointerCapture(event.pointerId)) {
      container.releasePointerCapture(event.pointerId);
    }
    if (!drag.moved) {
      const territory =
        territoryFromClientPoint(event.clientX, event.clientY) ??
        (container ? nearestTerritoryFromClientPoint(container, event.clientX, event.clientY) : null) ??
        drag.clickTerritory;
      if (territory) onSelectTerritory(territory, { x: event.clientX, y: event.clientY });
    }
  }

  function handlePointerLeave(): void {
    setHoveredTerritory(null);
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
      {pendingOrders.length > 0 && (
        <div className="order-legend" aria-label="Order symbols">
          <span><i className="legend-hold" /> Hold</span>
          <span><i className="legend-move" /> Move</span>
          <span><i className="legend-support" /> Support</span>
          <span><i className="legend-convoy" /> Convoy</span>
        </div>
      )}
      {pendingControlCount > 0 && (
        <div className="control-legend">
          <i /> Occupier differs from current owner
        </div>
      )}
      <div
        className={`map-viewport ${orderTargeting ? 'order-targeting' : ''}`}
        ref={containerRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onPointerLeave={handlePointerLeave}
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

function pendingSupplyControl(gameState: Pick<GameState, 'units' | 'territories'>): Array<{
  territory: TerritoryId;
  power: Unit['power'];
}> {
  return gameState.units.flatMap(unit => {
    if (unit.mustRetreat) return [];
    const territory = gameState.territories[unit.territory];
    if (!territory?.isSupplyCenter || territory.owner === unit.power) return [];
    return [{ territory: unit.territory, power: unit.power }];
  });
}

function renderPendingSupplyControl(
  svg: SVGSVGElement,
  pendingControl: Array<{ territory: TerritoryId; power: Unit['power'] }>
): void {
  svg.querySelector('#pending-supply-control')?.remove();
  const layer = document.createElementNS(SVG_NAMESPACE, 'g');
  layer.id = 'pending-supply-control';
  layer.setAttribute('aria-hidden', 'true');

  for (const item of pendingControl) {
    const province = INTERNAL_TO_SVG[item.territory] ?? item.territory.toLowerCase();
    const anchor = svg.getElementById(`${province}Center`);
    if (!(anchor instanceof SVGGraphicsElement)) continue;
    const box = anchor.getBBox();
    const marker = document.createElementNS(SVG_NAMESPACE, 'circle');
    marker.classList.add('pending-control-marker');
    marker.setAttribute('cx', String(box.x + box.width / 2));
    marker.setAttribute('cy', String(box.y + box.height / 2));
    marker.setAttribute('r', '25');
    marker.style.setProperty('--occupier-color', POWER_COLORS[item.power]);
    layer.append(marker);
  }

  const units = svg.querySelector('#units');
  units?.parentNode?.insertBefore(layer, units);
}

function resetDynamicPatterns(svg: SVGSVGElement): SVGDefsElement {
  svg.querySelector('#dynamic-control-patterns')?.remove();
  const defs = document.createElementNS(SVG_NAMESPACE, 'defs');
  defs.id = 'dynamic-control-patterns';
  svg.prepend(defs);
  return defs;
}

function createControlPattern(
  defs: SVGDefsElement,
  territory: TerritoryId,
  baseColor: string,
  occupierColor: string
): string {
  const id = `pending-control-pattern-${territory}`;
  const pattern = document.createElementNS(SVG_NAMESPACE, 'pattern');
  pattern.id = id;
  pattern.setAttribute('patternUnits', 'userSpaceOnUse');
  pattern.setAttribute('width', '18');
  pattern.setAttribute('height', '18');
  pattern.setAttribute('patternTransform', 'rotate(45)');

  const base = document.createElementNS(SVG_NAMESPACE, 'rect');
  base.setAttribute('width', '18');
  base.setAttribute('height', '18');
  base.setAttribute('fill', baseColor);

  const stripe = document.createElementNS(SVG_NAMESPACE, 'rect');
  stripe.setAttribute('x', '0');
  stripe.setAttribute('y', '0');
  stripe.setAttribute('width', '7');
  stripe.setAttribute('height', '18');
  stripe.setAttribute('fill', occupierColor);
  stripe.setAttribute('fill-opacity', '0.9');

  const outline = document.createElementNS(SVG_NAMESPACE, 'rect');
  outline.setAttribute('x', '7');
  outline.setAttribute('y', '0');
  outline.setAttribute('width', '1.5');
  outline.setAttribute('height', '18');
  outline.setAttribute('fill', '#101820');
  outline.setAttribute('fill-opacity', '0.35');

  pattern.append(base, stripe, outline);
  defs.append(pattern);
  return `url(#${id})`;
}

/** Two #rrggbb colors blended: `amount` of the second. */
function mixColors(first: string, second: string, amount: number): string {
  const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  return `#${[0, 1, 2].map(i => Math.round(channel(first, i) * (1 - amount) + channel(second, i) * amount).toString(16).padStart(2, '0')).join('')}`;
}

function renderUnits(
  svg: SVGSVGElement,
  units: Unit[],
  selectedUnitId: string | null,
  animationFrom?: Unit[]
): void {
  const layer = svg.querySelector<SVGGElement>('#units');
  if (!layer) return;
  layer.style.pointerEvents = 'auto';
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
    marker.classList.toggle('selected', unit.id === selectedUnitId);
    if (unit.mustRetreat) marker.classList.add('must-retreat');
    marker.dataset.territory = unit.territory;
    marker.dataset.unitId = unit.id;
    marker.setAttribute('transform', `translate(${x} ${y})`);
    marker.setAttribute('tabindex', '0');
    marker.setAttribute('focusable', 'true');
    marker.setAttribute('role', 'button');
    marker.style.setProperty('--unit-color', POWER_COLORS[unit.power]);
    marker.setAttribute(
      'aria-label',
      `${unit.power} ${unit.type.toLowerCase()} in ${territoryName(unit.territory)}`
    );

    const body = document.createElementNS(SVG_NAMESPACE, 'rect');
    const selected = unit.id === selectedUnitId;
    body.setAttribute('x', selected ? '-24' : '-18');
    body.setAttribute('y', selected ? '-18' : '-13');
    body.setAttribute('width', selected ? '48' : '36');
    body.setAttribute('height', selected ? '36' : '26');
    body.setAttribute('rx', unit.type === 'FLEET' ? (selected ? '18' : '13') : (selected ? '7' : '5'));

    const label = document.createElementNS(SVG_NAMESPACE, 'text');
    label.setAttribute('x', '0');
    label.setAttribute('y', '6');
    label.textContent = unit.type === 'FLEET' ? 'F' : 'A';

    marker.append(body, label);
    layer.append(marker);

    const previous = animationFrom?.find(candidate => candidate.id === unit.id);
    if (
      previous &&
      (previous.territory !== unit.territory || previous.coast !== unit.coast) &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      const previousCenter = territoryCenter(svg, previous.territory, previous.coast);
      if (previousCenter) {
        // An animated CSS transform replaces the marker's transform attribute while it runs, so both
        // ends are absolute map positions; offsets from the new place would start from the map's corner.
        marker.animate(
          [
            { transform: `translate(${previousCenter.x}px, ${previousCenter.y}px)` },
            { transform: `translate(${x}px, ${y}px)` },
          ],
          {
            duration: 900,
            easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
          }
        );
      }
    }
  }
}

function renderOrders(svg: SVGSVGElement, orders: Order[]): void {
  const layer = svg.querySelector<SVGGElement>('#orders');
  if (!layer) return;
  layer.replaceChildren();

  for (const order of orders) {
    const source = territoryCenter(svg, order.unitTerritory, order.unitCoast);
    if (!source) continue;
    const color = POWER_COLORS[order.power];
    const visual = document.createElementNS(SVG_NAMESPACE, 'g');
    visual.classList.add('order-visual');
    if ('resolution' in order && typeof order.resolution === 'string') {
      visual.classList.add(`result-${order.resolution.toLowerCase()}`);
    }
    layer.append(visual);

    if (order.type === 'HOLD') {
      drawOrderRing(visual, source, color, 'H');
      continue;
    }

    if (order.type === 'MOVE' && order.targetTerritory) {
      const target = territoryCenter(svg, order.targetTerritory, order.targetCoast);
      if (target) drawOrderArrow(visual, source, target, color, 'move');
      continue;
    }

    if (order.type === 'SUPPORT_HOLD' && order.supportedUnit) {
      const supported = territoryCenter(svg, order.supportedUnit, null);
      if (supported) {
        drawOrderArrow(visual, source, supported, color, 'support-hold', false);
        drawOrderRing(visual, supported, color, 'S', 24);
      }
      continue;
    }

    if (order.type === 'SUPPORT_MOVE' && order.supportedDestination) {
      const destination = territoryCenter(svg, order.supportedDestination, null);
      if (destination) {
        drawOrderArrow(visual, source, destination, color, 'support-move');
        drawOrderBadge(visual, source, 'S');
      }
      continue;
    }

    if (order.type === 'CONVOY' && order.supportedUnit && order.targetTerritory) {
      const army = territoryCenter(svg, order.supportedUnit, null);
      const destination = territoryCenter(svg, order.targetTerritory, null);
      if (army && destination) {
        drawOrderArrow(visual, army, source, color, 'convoy', false);
        drawOrderArrow(visual, source, destination, color, 'convoy');
        drawOrderBadge(visual, source, 'C');
      }
    }
  }
}

function drawOrderArrow(
  layer: SVGGElement,
  source: Point,
  target: Point,
  color: string,
  kind: 'move' | 'support-hold' | 'support-move' | 'convoy',
  arrow = true
): void {
  const shortened = shortenLine(source, target, 22, arrow ? 20 : 22);
  let lineEnd = shortened.end;
  if (arrow) {
    const dx = shortened.end.x - shortened.start.x;
    const dy = shortened.end.y - shortened.start.y;
    const distance = Math.hypot(dx, dy) || 1;
    const arrowLength = 18;
    lineEnd = {
      x: shortened.end.x - dx / distance * (arrowLength - 1),
      y: shortened.end.y - dy / distance * (arrowLength - 1),
    };
  }
  drawOrderLine(layer, shortened.start, lineEnd, color, kind, true);
  drawOrderLine(layer, shortened.start, lineEnd, color, kind, false);
  if (arrow) drawArrowHead(layer, shortened.start, shortened.end, color, kind);
}

function drawOrderLine(
  layer: SVGGElement,
  source: Point,
  target: Point,
  color: string,
  kind: 'move' | 'support-hold' | 'support-move' | 'convoy',
  outline: boolean
): void {
  const line = document.createElementNS(SVG_NAMESPACE, 'line');
  line.classList.add(outline ? 'order-path-outline' : 'order-path', `order-${kind}`);
  line.setAttribute('x1', String(source.x));
  line.setAttribute('y1', String(source.y));
  line.setAttribute('x2', String(target.x));
  line.setAttribute('y2', String(target.y));
  line.style.setProperty('--order-color', color);
  layer.append(line);
}

function drawArrowHead(
  layer: SVGGElement,
  source: Point,
  target: Point,
  color: string,
  kind: string
): void {
  const angle = Math.atan2(target.y - source.y, target.x - source.x);
  const length = 18;
  const width = 10;
  const back = {
    x: target.x - Math.cos(angle) * length,
    y: target.y - Math.sin(angle) * length,
  };
  const points = [
    target,
    {
      x: back.x + Math.cos(angle + Math.PI / 2) * width,
      y: back.y + Math.sin(angle + Math.PI / 2) * width,
    },
    {
      x: back.x + Math.cos(angle - Math.PI / 2) * width,
      y: back.y + Math.sin(angle - Math.PI / 2) * width,
    },
  ];
  const head = document.createElementNS(SVG_NAMESPACE, 'polygon');
  head.classList.add('order-arrowhead', `order-${kind}`);
  head.setAttribute('points', points.map(point => `${point.x},${point.y}`).join(' '));
  head.style.setProperty('--order-color', color);
  layer.append(head);
}

function drawOrderRing(
  layer: SVGGElement,
  center: Point,
  color: string,
  label: string,
  radius = 27
): void {
  const ring = document.createElementNS(SVG_NAMESPACE, 'circle');
  ring.classList.add('order-ring');
  ring.setAttribute('cx', String(center.x));
  ring.setAttribute('cy', String(center.y));
  ring.setAttribute('r', String(radius));
  ring.style.setProperty('--order-color', color);
  layer.append(ring);
  drawOrderBadge(layer, center, label);
}

function drawOrderBadge(layer: SVGGElement, center: Point, label: string): void {
  const badge = document.createElementNS(SVG_NAMESPACE, 'text');
  badge.classList.add('order-badge');
  badge.setAttribute('x', String(center.x));
  badge.setAttribute('y', String(center.y - 24));
  badge.textContent = label;
  layer.append(badge);
}

interface Point {
  x: number;
  y: number;
}

function territoryCenter(
  svg: SVGSVGElement,
  territory: TerritoryId,
  coast: Coast | null
): Point | null {
  const province = INTERNAL_TO_SVG[territory] ?? territory.toLowerCase();
  const coastSuffix = coast ? `/${{
    NORTH: 'nc',
    SOUTH: 'sc',
    EAST: 'ec',
    WEST: 'wc',
  }[coast]}` : '';
  const anchor =
    svg.getElementById(`${province}${coastSuffix}Center`) ??
    svg.getElementById(`${province}Center`);
  if (!(anchor instanceof SVGGraphicsElement)) return null;
  const box = anchor.getBBox();
  return {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  };
}

function centerMapOnPoint(
  container: HTMLDivElement,
  svg: SVGSVGElement,
  point: Point
): void {
  const viewBox = svg.viewBox.baseVal;
  if (!viewBox || viewBox.width === 0 || viewBox.height === 0) return;
  // Called after layout, so these rectangles already reflect the new zoom. The drawing keeps its
  // aspect ratio and is centred inside its box, so work out where the point is from that.
  const box = svg.getBoundingClientRect();
  const frame = container.getBoundingClientRect();
  const scale = Math.min(box.width / viewBox.width, box.height / viewBox.height);
  const x = box.left + (box.width - viewBox.width * scale) / 2 + (point.x - viewBox.x) * scale;
  const y = box.top + (box.height - viewBox.height * scale) / 2 + (point.y - viewBox.y) * scale;
  container.scrollLeft += x - (frame.left + container.clientWidth / 2);
  container.scrollTop += y - (frame.top + container.clientHeight / 2);
}

function shortenLine(
  source: Point,
  target: Point,
  sourcePadding: number,
  targetPadding: number
): { start: Point; end: Point } {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const distance = Math.hypot(dx, dy) || 1;
  return {
    start: {
      x: source.x + dx / distance * sourcePadding,
      y: source.y + dy / distance * sourcePadding,
    },
    end: {
      x: target.x - dx / distance * targetPadding,
      y: target.y - dy / distance * targetPadding,
    },
  };
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

function territoryFromEventTarget(target: EventTarget | null): TerritoryId | null {
  if (!(target instanceof Element)) return null;
  return target.closest<SVGElement>('[data-territory]')?.dataset.territory as TerritoryId | undefined ?? null;
}

function territoryFromClientPoint(clientX: number, clientY: number): TerritoryId | null {
  for (const element of document.elementsFromPoint(clientX, clientY)) {
    const territory = territoryFromEventTarget(element);
    if (territory) return territory;
  }
  return null;
}

function nearestTerritoryFromClientPoint(
  container: HTMLDivElement,
  clientX: number,
  clientY: number
): TerritoryId | null {
  const svg = container.querySelector('svg');
  if (!(svg instanceof SVGSVGElement)) return null;
  const screenMatrix = svg.getScreenCTM();
  if (!screenMatrix) return null;

  const point = svg.createSVGPoint();
  point.x = clientX;
  point.y = clientY;
  const svgPoint = point.matrixTransform(screenMatrix.inverse());

  let nearest: { territory: TerritoryId; distance: number } | null = null;
  for (const shape of Array.from(svg.querySelectorAll<SVGElement>('.province-shape[data-territory]'))) {
    const territory = shape.dataset.territory as TerritoryId | undefined;
    if (!territory) continue;
    const center = territoryCenter(svg, territory, null);
    if (!center) continue;
    const distance = Math.hypot(center.x - svgPoint.x, center.y - svgPoint.y);
    if (!nearest || distance < nearest.distance) nearest = { territory, distance };
  }

  return nearest?.territory ?? null;
}

function inverseHexColor(hex: string): string {
  const normalized = hex.replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return '#ffffff';
  const red = 255 - Number.parseInt(normalized.slice(0, 2), 16);
  const green = 255 - Number.parseInt(normalized.slice(2, 4), 16);
  const blue = 255 - Number.parseInt(normalized.slice(4, 6), 16);
  return `#${[red, green, blue]
    .map(channel => channel.toString(16).padStart(2, '0'))
    .join('')}`;
}

function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}
