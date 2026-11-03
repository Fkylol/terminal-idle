import './style.css'
import { GAME_CONFIG, type MachineId } from './config'
import {
  advanceGame,
  buyMachine,
  createGameState,
  getMachine,
  getMachineProduction,
  getNextPrice,
  getProductionPerSecond,
  getPurchasePlan,
  getTimeToAfford,
  isMachineUnlocked,
  type BuyMode,
} from './game'

function requireElement<T extends HTMLElement>(selector: string, root: ParentNode = document): T {
  const element = root.querySelector<T>(selector)

  if (!element) {
    throw new Error(`Élément ${selector} introuvable : vérifie index.html.`)
  }

  return element
}

const creditsElement = requireElement<HTMLElement>('[data-credits]')
const productionElement = requireElement<HTMLElement>('[data-production]')
const machinesList = requireElement<HTMLUListElement>('[data-machines]')
const modeButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-mode]')]

const creditFormatter = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 })
const rateFormatter = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 })

const state = createGameState(performance.now())
let mode: BuyMode = '1'

interface MachineView {
  id: MachineId
  row: HTMLElement
  owned: HTMLElement
  unit: HTMLElement
  total: HTMLElement
  price: HTMLElement
  eta: HTMLElement
  button: HTMLButtonElement
  lockNote: HTMLElement
}

const MACHINE_MARKUP = `
  <div class="machine__head">
    <span class="machine__name" data-name></span>
    <span class="machine__owned" data-owned></span>
    <span class="machine__lock">[LOCKED]</span>
  </div>
  <p class="machine__lock-note" data-lock-note></p>
  <dl class="machine__stats">
    <div class="machine__stat"><dt>UNITAIRE</dt><dd data-unit></dd></div>
    <div class="machine__stat"><dt>TOTAL</dt><dd data-total></dd></div>
    <div class="machine__stat"><dt>PRIX</dt><dd data-price></dd></div>
  </dl>
  <div class="machine__action">
    <button type="button" class="machine__buy" data-buy></button>
    <span class="machine__eta" data-eta></span>
  </div>
`

function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) {
    element.textContent = text
  }
}

/** « 12 s », « 3 min 05 s », « 2 h 14 min », « 1 j 3 h ». */
function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) {
    return '—'
  }

  const total = Math.max(0, Math.ceil(seconds))

  if (total < 60) {
    return `${total} s`
  }

  if (total < 3_600) {
    return `${Math.floor(total / 60)} min ${String(total % 60).padStart(2, '0')} s`
  }

  if (total < 86_400) {
    return `${Math.floor(total / 3_600)} h ${String(Math.floor((total % 3_600) / 60)).padStart(2, '0')} min`
  }

  return `${Math.floor(total / 86_400)} j ${Math.floor((total % 86_400) / 3_600)} h`
}

function formatCredits(value: number): string {
  return creditFormatter.format(value)
}

function handleBuy(machineId: MachineId): void {
  if (buyMachine(state, machineId, mode, performance.now())) {
    render()
  }
}

function createMachineView(machineId: MachineId): MachineView {
  const machine = getMachine(machineId)
  const row = document.createElement('li')
  row.className = 'machine'
  row.innerHTML = MACHINE_MARKUP

  requireElement<HTMLElement>('[data-name]', row).textContent = machine.name

  const button = requireElement<HTMLButtonElement>('[data-buy]', row)
  button.addEventListener('click', () => handleBuy(machineId))

  return {
    id: machineId,
    row,
    owned: requireElement<HTMLElement>('[data-owned]', row),
    unit: requireElement<HTMLElement>('[data-unit]', row),
    total: requireElement<HTMLElement>('[data-total]', row),
    price: requireElement<HTMLElement>('[data-price]', row),
    eta: requireElement<HTMLElement>('[data-eta]', row),
    button,
    lockNote: requireElement<HTMLElement>('[data-lock-note]', row),
  }
}

function renderMachine(view: MachineView): void {
  const unlocked = isMachineUnlocked(state, view.id)
  view.row.classList.toggle('machine--locked', !unlocked)

  if (!unlocked) {
    const threshold = getMachine(view.id).basePrice
    setText(view.lockNote, `Déblocage à ${formatCredits(threshold)} CR gagnés`)
    return
  }

  const machine = getMachine(view.id)
  const plan = getPurchasePlan(state, view.id, mode)
  const count = plan.count > 0 ? plan.count : 1
  const cost = plan.count > 0 ? plan.cost : getNextPrice(state, view.id)
  const affordable = plan.count > 0 && plan.cost <= state.credits

  setText(view.owned, `×${formatCredits(state.ownedMachines[view.id])}`)
  setText(view.unit, `${rateFormatter.format(machine.production)} CR/s`)
  setText(view.total, `${rateFormatter.format(getMachineProduction(state, view.id))} CR/s`)
  setText(view.price, `${formatCredits(cost)} CR`)

  view.button.textContent =
    mode === 'max' ? `ACHETER MAX${plan.count > 0 ? ` (${plan.count})` : ''}` : `ACHETER ×${count}`
  view.button.disabled = !affordable

  view.eta.classList.toggle('machine__eta--ready', affordable)
  setText(view.eta, affordable ? 'Disponible' : `≈ ${formatDuration(getTimeToAfford(state, cost))}`)
}

function render(): void {
  setText(creditsElement, formatCredits(Math.floor(state.credits)))
  setText(productionElement, rateFormatter.format(getProductionPerSecond(state)))

  for (const view of views) {
    renderMachine(view)
  }
}

function setMode(nextMode: BuyMode): void {
  mode = nextMode

  for (const button of modeButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === nextMode))
  }

  render()
}

const views = GAME_CONFIG.machines.map((machine) => createMachineView(machine.id))
machinesList.append(...views.map((view) => view.row))

for (const button of modeButtons) {
  button.addEventListener('click', () => setMode(button.dataset.mode as BuyMode))
}

function frame(now: number): void {
  advanceGame(state, now)
  render()
  requestAnimationFrame(frame)
}

render()
requestAnimationFrame(frame)
