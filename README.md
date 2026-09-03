# KanbanViz Copilot plugin marketplace

This repository hosts the public KanbanViz plugin catalog and versioned Windows release assets.

## Install

```powershell
copilot plugin marketplace add hngye02/KanbanViz-Releases
copilot plugin install kanbanviz@kanbanviz
```

Restart the GitHub Copilot app, start a new session, and open the **KanbanViz** Canvas. The first
launch downloads `KanbanViz-Canvas-Server-0.2.5-win-x64.zip`, verifies its SHA256 from the signed plugin manifest, installs
it under `%LOCALAPPDATA%\KanbanViz\canvas-extension\runtimes\`, and starts the loopback-only server.

## Update

```powershell
copilot plugin marketplace update kanbanviz
copilot plugin update kanbanviz@kanbanviz
```

Plugin version: `0.2.5`
