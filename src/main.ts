import './style.css'
import { GAME_CONFIG, type MachineId, type UpgradeId } from './config'
import {
  advanceGame,
  buyMachine,
  buyUpgrade,
  createGameState,
  getMachine,
  getMachineProduction,
  getNextPrice,
  getProductionPerSecond,
  getPurchasePlan,
  getTimeToAfford,
  getUpgrade,
  getUpgradeCost,
  getUpgradeLevel,
  isMachineUnlocked,
  isUpgradeMaxed,
  type BuyMode,
  type GameState,
} from './game'
import {
  applyOfflineGain,
  clearGameSave,
  computeOfflineGain,
  loadGame,
  saveGame,
  type OfflineReport,
} from './save'

/** Intervalle de sauvegarde automatique. */
const AUTOSAVE_INTERVAL_MS = 10_000
/** En dessous de cette absence, aucun rapport n'est affiché (crédits quand même versés). */
const REPORT_MIN_ABSENT_SECONDS = 60

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
const upgradesList = requireElement<HTMLUListElement>('[data-upgrades]')
const modeButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-mode]')]

const reportElement = requireElement<HTMLElement>('[data-report]')
const reportAbsent = requireElement<HTMLElement>('[data-report-absent]')
const reportCredited = requireElement<HTMLElement>('[data-report-credited]')
const reportGain = requireElement<HTMLElement>('[data-report-gain]')
const reportCap = requireElement<HTMLElement>('[data-report-cap]')
const reportClose = requireElement<HTMLButtonElement>('[data-report-close]')
const resetButton = requireElement<HTMLButtonElement>('[data-reset]')

const creditFormatter = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 })
const rateFormatter = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 })
const percentFormatter = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 })

/* ---- Restauration de la partie ---- */

const saved = loadGame()
let state: GameState
let lastSavedAt: number
let pendingReport: OfflineReport | null = null

if (saved) {
  const now = Date.now()
  state = saved.state
  lastSavedAt = saved.lastSavedAt

  const report = computeOfflineGain(
    getProductionPerSecond(state),
    saved.lastSavedAt,
    now,
    GAME_CONFIG.offlineCapSeconds,
  )
  applyOfflineGain(state, report)

  if (report.creditsEarned > 0 && report.absentSeconds >= REPORT_MIN_ABSENT_SECONDS) {
    pendingReport = report
  }

  lastSavedAt = now
} else {
  state = createGameState(performance.now())
  lastSavedAt = Date.now()
}

// L'horodatage de tick vient de performance.now, pas de la sauvegarde.
state.lastTick = performance.now()

let mode: BuyMode = '1'

/* ---- Sauvegarde ---- */

/**
 * Crédite la production jusqu'à maintenant, puis enregistre l'état avec
 * l'horodatage de ce même instant : les gains postérieurs à la sauvegarde
 * seront comptés une seule fois, au retour du joueur.
 */
function persist(): void {
  advanceGame(state, performance.now())
  lastSavedAt = Date.now()
  saveGame(state, lastSavedAt)
}

// Première écriture immédiate : les gains hors ligne viennent d'être versés et
// ne doivent jamais être attribués une deuxième fois.
persist()

/* ---- Mise en forme ---- */

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

/* ---- Machines ---- */

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

function handleBuy(machineId: MachineId): void {
  if (buyMachine(state, machineId, mode, performance.now())) {
    persist()
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

/* ---- Améliorations ---- */

interface UpgradeView {
  id: UpgradeId
  row: HTMLElement
  level: HTMLElement
  maxBadge: HTMLElement
  bonus: HTMLElement
  price: HTMLElement
  eta: HTMLElement
  button: HTMLButtonElement
}

const UPGRADE_MARKUP = `
  <div class="upgrade__head">
    <span class="upgrade__name" data-name></span>
    <span class="upgrade__max">[MAX]</span>
    <span class="upgrade__level" data-level></span>
  </div>
  <dl class="upgrade__stats">
    <div class="upgrade__stat"><dt>BONUS ACTUEL</dt><dd data-bonus></dd></div>
    <div class="upgrade__stat"><dt>PROCHAIN NIVEAU</dt><dd data-price></dd></div>
  </dl>
  <div class="upgrade__action">
    <button type="button" class="upgrade__buy" data-buy></button>
    <span class="upgrade__eta" data-eta></span>
  </div>
`

function handleBuyUpgrade(upgradeId: UpgradeId): void {
  if (buyUpgrade(state, upgradeId, performance.now())) {
    persist()
    render()
  }
}

function createUpgradeView(upgradeId: UpgradeId): UpgradeView {
  const upgrade = getUpgrade(upgradeId)
  const row = document.createElement('li')
  row.className = 'upgrade'
  row.innerHTML = UPGRADE_MARKUP

  requireElement<HTMLElement>('[data-name]', row).textContent = upgrade.name

  const button = requireElement<HTMLButtonElement>('[data-buy]', row)
  button.addEventListener('click', () => handleBuyUpgrade(upgradeId))

  return {
    id: upgradeId,
    row,
    level: requireElement<HTMLElement>('[data-level]', row),
    maxBadge: requireElement<HTMLElement>('.upgrade__max', row),
    bonus: requireElement<HTMLElement>('[data-bonus]', row),
    price: requireElement<HTMLElement>('[data-price]', row),
    eta: requireElement<HTMLElement>('[data-eta]', row),
    button,
  }
}

function renderUpgrade(view: UpgradeView): void {
  const upgrade = getUpgrade(view.id)
  const level = getUpgradeLevel(state, view.id)
  const maxed = isUpgradeMaxed(state, view.id)

  setText(view.level, `[NIVEAU ${level}/${GAME_CONFIG.maxUpgradeLevel}]`)
  setText(view.bonus, `+${percentFormatter.format(upgrade.bonusPerLevel * level * 100)} %`)
  view.maxBadge.hidden = !maxed

  if (maxed) {
    setText(view.price, '—')
    view.button.textContent = 'NIVEAU MAX'
    view.button.disabled = true
    view.eta.classList.remove('upgrade__eta--ready')
    setText(view.eta, '[MAX]')
    return
  }

  const cost = getUpgradeCost(state, view.id)
  const affordable = cost <= state.credits

  setText(view.price, `${formatCredits(cost)} CR`)
  view.button.textContent = `ACHETER NIVEAU ${level + 1}`
  view.button.disabled = !affordable
  view.eta.classList.toggle('upgrade__eta--ready', affordable)
  setText(view.eta, affordable ? 'Disponible' : `≈ ${formatDuration(getTimeToAfford(state, cost))}`)
}

/* ---- Rapport de retour ---- */

function showReport(report: OfflineReport): void {
  setText(reportAbsent, formatDuration(report.absentSeconds))
  setText(reportCredited, formatDuration(report.creditedSeconds))
  setText(reportGain, `+${formatCredits(Math.floor(report.creditsEarned))} CR`)
  reportCap.hidden = !report.capped
  reportElement.hidden = false
}

function hideReport(): void {
  reportElement.hidden = true
}

/* ---- Rendu global ---- */

function render(): void {
  setText(creditsElement, formatCredits(Math.floor(state.credits)))
  setText(productionElement, rateFormatter.format(getProductionPerSecond(state)))

  for (const view of machineViews) {
    renderMachine(view)
  }

  for (const view of upgradeViews) {
    renderUpgrade(view)
  }
}

function setMode(nextMode: BuyMode): void {
  mode = nextMode

  for (const button of modeButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === nextMode))
  }

  render()
}

/* ---- Nouvelle partie ---- */

function startNewGame(): void {
  const confirmed = window.confirm(
    'Nouvelle partie : la progression et la sauvegarde actuelles seront définitivement supprimées. Continuer ?',
  )

  if (!confirmed) {
    return
  }

  clearGameSave()
  state = createGameState(performance.now())
  lastSavedAt = Date.now()
  hideReport()
  setMode('1')
  persist()
  render()
}

/* ---- Branchement ---- */

const machineViews = GAME_CONFIG.machines.map((machine) => createMachineView(machine.id))
machinesList.append(...machineViews.map((view) => view.row))

const upgradeViews = GAME_CONFIG.upgrades.map((upgrade) => createUpgradeView(upgrade.id))
upgradesList.append(...upgradeViews.map((view) => view.row))

for (const button of modeButtons) {
  button.addEventListener('click', () => setMode(button.dataset.mode as BuyMode))
}

reportClose.addEventListener('click', hideReport)
resetButton.addEventListener('click', startNewGame)

window.addEventListener('pagehide', persist)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    persist()
  }
})
window.setInterval(persist, AUTOSAVE_INTERVAL_MS)

if (pendingReport) {
  showReport(pendingReport)
}

function frame(now: number): void {
  advanceGame(state, now)
  render()
  requestAnimationFrame(frame)
}

render()
requestAnimationFrame(frame)
