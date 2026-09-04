import { describe, expect, it } from 'vitest'

import { CLUSTER_MAX_ZOOM, cellSizeForZoom, clusterLives, isCluster } from './cluster'
import type { LiveMarker } from './markers'

function live(id: string, lat: number, lng: number, participantCount = 1): LiveMarker {
  return {
    kind: 'live',
    id: `live:${id}`,
    roomId: id as LiveMarker['roomId'],
    position: { lat, lng },
    title: `${id} is live`,
    participantCount,
    precision: 'city',
    faces: [],
  }
}

describe('clusterLives', () => {
  it('halves the cell with every zoom level', () => {
    expect(cellSizeForZoom(0)).toBe(40)
    expect(cellSizeForZoom(1)).toBe(20)
    expect(cellSizeForZoom(3)).toBe(5)
  })

  it('collapses nearby Lives into one cluster at a world zoom and keeps far ones apart', () => {
    const items = clusterLives(
      [live('a', 37.76, -122.42, 2), live('b', 37.77, -122.41, 3), live('c', 40.71, -74.0)],
      1.4,
    )
    const clusters = items.filter(isCluster)
    expect(clusters).toHaveLength(1)
    expect(clusters[0]!.count).toBe(2)
    expect(clusters[0]!.participantCount).toBe(5)
    expect(clusters[0]!.members.map((m) => m.id)).toEqual(['live:a', 'live:b'])
    expect(items.filter((item) => !isCluster(item)).map((item) => item.id)).toEqual(['live:c'])
  })

  it('never clusters at street zoom', () => {
    const items = clusterLives(
      [live('a', 37.76, -122.42), live('b', 37.7601, -122.4201)],
      CLUSTER_MAX_ZOOM,
    )
    expect(items.every((item) => !isCluster(item))).toBe(true)
  })

  it('is stable: the same input gives the same ids', () => {
    const input = [live('a', 1, 1), live('b', 1.1, 1.1)]
    expect(clusterLives(input, 2)).toEqual(clusterLives(input, 2))
  })
})
