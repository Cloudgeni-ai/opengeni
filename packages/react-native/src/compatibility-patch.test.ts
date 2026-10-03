import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CodexFleetDecisionEventPayload, SessionEvent } from '@opengeni/sdk'
import { buildTimeline } from '@opengeni/react/session'

const root = join(import.meta.dir, '../../..')

function objectProperty(value: unknown, name: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  const property: unknown = Reflect.get(value, name)
  return property
}

const publishedCanary: unknown = JSON.parse(
  readFileSync(join(root, 'scripts/opengeni/published-canary.json'), 'utf8')
)
const publishedReactVersionValue = objectProperty(
  objectProperty(objectProperty(publishedCanary, 'packages'), '@opengeni/react'),
  'version'
)
const publishedReactVersion =
  typeof publishedReactVersionValue === 'string' ? publishedReactVersionValue : undefined

function dependencyVersion(value: unknown, name: string): string | undefined {
  const version = objectProperty(objectProperty(value, 'dependencies'), name)
  return typeof version === 'string' ? version : undefined
}

describe('@opengeni/react React Native Hermes compatibility', () => {
  test('uses the coherent published canary package', () => {
    const mobilePackageJson: unknown = JSON.parse(
      readFileSync(join(root, 'apps/mobile/package.json'), 'utf8')
    )
    const nativePackageJson: unknown = JSON.parse(
      readFileSync(join(root, 'packages/opengeni-react-native/package.json'), 'utf8')
    )

    expect(dependencyVersion(mobilePackageJson, '@opengeni/react')).toBe(publishedReactVersion)
    expect(dependencyVersion(nativePackageJson, '@opengeni/react')).toBe(publishedReactVersion)
  })

  test('leaves no offending top-level await in the installed projection source', () => {
    const projection = readFileSync(
      join(root, 'node_modules/@opengeni/react/src/timeline/projection.ts'),
      'utf8'
    )

    expect(projection).toContain('import fleetDecisionItem from "./fleet-decision-projection";')
    expect(projection).not.toContain('await import("./fleet-decision-projection")')
  })

  test('preserves fleet-decision projection through the official session export', () => {
    const payload: CodexFleetDecisionEventPayload = {
      schemaVersion: 1,
      mode: 'shadow',
      actual: { outcome: 'selected', candidateKey: 'c00', reason: 'active' },
      comparison: 'match',
      replay: {
        schemaVersion: 1,
        policyVersion: 'adaptive-shadow-v1',
        mode: 'shadow',
        input: { candidates: [{ key: 'c00' }] },
        truncatedCandidateCount: 0,
        inputFingerprint: 'input',
        decisionFingerprint: 'decision',
        decision: {
          outcome: 'selected',
          selectedCandidateKey: 'c00',
          reason: 'best_score',
          admission: {
            outcome: 'admit',
            reason: 'capacity_available',
            borrowedIdleCapacity: false,
          },
          borrowedOverlayCapacity: false,
          strandedEligibleCount: 0,
          confidence: 'high',
          scores: [
            {
              candidateKey: 'c00',
              eligible: true,
              rejectionReason: null,
              quotaPressure: 0,
              leasePressure: 0,
              observedBurnPressure: 0,
              inferredBurnPressure: 0,
              runwayPressure: 0,
              uncertaintyPressure: 0,
              cacheAffinityBenefit: 0,
              cacheState: 'healthy',
              overlayPreferenceBenefit: 0,
              total: 1,
              confidence: 'high',
            },
          ],
        },
      },
    }
    const event: SessionEvent = {
      id: 'event-1',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      sequence: 1,
      type: 'codex.fleet.decision',
      payload,
      occurredAt: '2026-08-09T00:00:00.000Z',
    }

    expect(buildTimeline([event])).toMatchObject([
      {
        kind: 'fleet-decision',
        actualOutcome: 'selected',
        actualCandidateKey: 'c00',
        shadowOutcome: 'selected',
        shadowCandidateKey: 'c00',
        comparison: 'match',
      },
    ])
  })
})
