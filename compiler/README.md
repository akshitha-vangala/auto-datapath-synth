# Auto Datapath Synthesiser

The **Auto Datapath Synthesiser** is a universal, educational High-Level Synthesis (HLS) compiler and cycle-accurate hardware visualiser. It was built to explore exactly how high-level algorithms are translated into Register Transfer Level (RTL) hardware.

Arbitrary high-level algorithmic code can be parsed, synthesized, and visually simulated to demonstrate how software logic maps onto physical datapaths.

---

# Features

## Universal OCaml Compiler

A custom C-like syntax — supporting constructs such as:

- `while` loops
- conditionals
- arithmetic operations
- bitwise operations

— is parsed by the OCaml backend.

The compiler automatically:

- Allocates hardware components such as Registers, Muxes, and ALUs
- Generates a precise Finite State Machine (FSM)
- Produces a complete RTL-style hardware specification exported as JSON

---

## Interactive RTL Visualisation

The generated JSON hardware specification is consumed by a React Flow-powered frontend dashboard.

The visualiser dynamically renders:

- Datapaths
- Registers
- Functional units
- Control logic
- Interconnect buses

Automatic graph routing is handled using **Dagre**.

During simulation:

- Active components are highlighted
- Data buses illuminate in real time
- Current execution state is visually tracked cycle-by-cycle

---

## Cycle-Accurate Simulation

A custom simulation engine enables accurate FSM execution at the clock-cycle level.

Supported controls include:

- Play / Pause
- Step Forward
- Step Backward
- Real-time execution
- Time-travel debugging

This allows users to inspect how data propagates through hardware over time.

---

## Live Fault Injection

Control signals can be manually overridden during simulation.

Examples include:

- Forcing a MUX select line
- Overriding enable signals
- Corrupting datapath routing

This makes it possible to directly observe how faults propagate through the circuit and affect execution behavior.

---

# Project Structure

The architecture is divided into two major systems:

## `compiler/hls_compiler/` — Backend

Written in **OCaml**, this subsystem handles:

- Lexing
- Parsing
- Datapath allocation
- FSM synthesis
- RTL generation

The backend compiles high-level algorithms into a hardware specification JSON.

---

## `visualiser/` — Frontend

Built with **React** and **Vite**, this subsystem:

- Consumes the generated JSON
- Dynamically renders the RTL datapath
- Runs the simulation engine
- Provides interactive debugging and visualisation tools

---

# Prerequisites

The following tools are required to run the project locally.

## Backend Requirements

- OCaml
- Dune

Installation guide:  
https://ocaml.org/docs/installing-ocaml

---

## Frontend Requirements

- Node.js
- npm

Download:  
https://nodejs.org/

---

# Getting Started

## 1. Synthesize the Hardware (Backend)

Generate the RTL hardware specification by compiling the target algorithm through the OCaml backend.

```bash
cd compiler/hls_compiler

dune build
dune exec hls_compiler
```

### Note

The compiler is configured so that `output.json` is automatically written into:

```text
visualiser/src/
```

This enables instant frontend hot-reloading whenever the hardware design changes.

---

## 2. Run the Visualiser (Frontend)

Open a new terminal window and start the frontend development server.

```bash
cd visualiser

npm install
npm run dev
```

Open the browser at:

```text
http://localhost:5173
```

to interact with the dashboard.

---

# Usage Guide

## Playback Controls

The simulation can be controlled using:

- Play / Pause buttons
- `Spacebar` for toggling execution
- Left / Right arrow keys for stepping through clock cycles

---

## Input Configurator

Initial values for algorithm variables can be configured from the left sidebar.

This allows testing of:

- Different execution paths
- Conditional branches
- Loop behavior
- Datapath activity under varying inputs

---

## Signal Overrides

FSM control signals can be manually overridden using the right sidebar.

Features include:

- Toggle control signals before the next clock edge
- Visual indication of active overrides
- Real-time datapath corruption analysis

### Reset Controls

The circuit state can be reset by:

- Clicking **"Clear All"**
- Pressing the `R` key

---

# Technologies Used

## Backend

- OCaml
- Menhir
- Ocamllex
- Dune

---

## Frontend

- React
- Vite
- React Flow
- Dagre (automatic graph layout engine)