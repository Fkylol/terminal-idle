import './style.css'
import { advanceGame, createGameState, getProductionPerSecond } from './game'

function requireElement(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector)

  if (!element) {
    throw new Error(`Élément ${selector} introuvable : vérifie index.html.`)
  }

  return element
}

const creditsElement = requireElement('[data-credits]')
const productionElement = requireElement('[data-production]')

const creditFormatter = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 })
const rateFormatter = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 })

const state = createGameState(performance.now())

function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) {
    element.textContent = text
  }
}

function render(): void {
  setText(creditsElement, creditFormatter.format(Math.floor(state.credits)))
  setText(productionElement, rateFormatter.format(getProductionPerSecond(state)))
}

function frame(now: number): void {
  advanceGame(state, now)
  render()
  requestAnimationFrame(frame)
}

render()
requestAnimationFrame(frame)
