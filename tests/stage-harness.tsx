import React from 'react';
import { createRoot } from 'react-dom/client';
import { MotionAnalysis } from '../src/shared/motion';
import { MotionStage } from '../src/renderer/motion/MotionStage';

const polygon = [
  { x: 120, y: 100 },
  { x: 420, y: 100 },
  { x: 420, y: 300 },
  { x: 120, y: 300 },
];

const analysis: MotionAnalysis = {
  id: 'stage-test',
  projectId: 'test',
  name: 'Stage test',
  media: {
    kind: 'image',
    path: '',
    name: 'stage-test.png',
    width: 1024,
    height: 768,
    duration: null,
    fps: null,
    frameCount: 1,
    timingSource: 'still',
    size: 0,
  },
  objects: [
    {
      id: 'object-1',
      name: 'Test object',
      color: '#67ceff',
      initialFrame: 0,
      initialPolygon: polygon,
      initialReferences: [],
      frames: [
        {
          frame: 0,
          time: 0,
          polygon,
          references: [],
          bbox: { x: 120, y: 100, width: 300, height: 200 },
          status: 'manual',
          quality: 100,
          qualityNotes: [],
          featureCount: 0,
          inlierRatio: 1,
          fbError: 0,
        },
      ],
      referenceLength: 0,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
  ],
  calibration: {
    mode: 'none',
    unit: 'mm',
    knownDistance: 0,
    origin: { x: 0, y: 0 },
    xAxisPoint: { x: 100, y: 0 },
    yAxisPoint: { x: 0, y: 100 },
    scalePointA: { x: 0, y: 0 },
    scalePointB: { x: 100, y: 0 },
    homographyPoints: [],
  },
  settings: {
    showAxes: false,
    showBoundingBox: true,
    showReferences: true,
    showTrajectory: true,
    showReadout: true,
    smoothingWindow: 3,
  },
  notes: '',
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
} as unknown as MotionAnalysis;

const noop = () => undefined;

function Harness() {
  return (
    <div id="scroller" style={{ height: 420, overflow: 'auto', background: '#101820' }}>
      <div style={{ width: 600 }}>
        <MotionStage
          analysis={analysis}
          mediaUrl=""
          videoUrl=""
          videoRef={React.createRef<HTMLVideoElement>()}
          selectedObject={analysis.objects[0]}
          frame={0}
          tool="select"
          draftPolygon={[]}
          draftReferences={[]}
          selectedPoint={0}
          readout={{ time: 0, x: 270, y: 200, speed: null, calibrated: false, unit: 'px' }}
          onCanvasPoint={noop}
          onRectangle={noop}
          onMovePoint={noop}
          onMoveReference={noop}
          onInsertPoint={noop}
          onBeginPointDrag={noop}
          onBeginReferenceDrag={noop}
          onSelectPoint={(index) => { (window as unknown as { __selectedPoint: number }).__selectedPoint = index; }}
          onCalibrationPoint={noop}
          onVideoTime={noop}
          onVideoReady={noop}
          onPlayState={noop}
          onFinishPolygon={noop}
        />
      </div>
      <div style={{ height: 1600 }} />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
