import { useState } from 'react'
import GlbUploader from './GlbUploader'
import ConsensusBoundaryExplorer from './ConsensusBoundaryExplorer'

function App() {
  const [glbData, setGlbData] = useState(null)
  const [glbFile, setGlbFile] = useState(null)

  if (!glbData) return <GlbUploader onData={(data, file) => { setGlbData(data); setGlbFile(file); }} />
  return <ConsensusBoundaryExplorer initialData={glbData} glbFile={glbFile} onExit={() => { setGlbData(null); setGlbFile(null); }} />
}

export default App
