export interface PlotBackend {
  connect(port: string): Promise<void>
  moveTo(x: number, y: number, speed: number): Promise<void>
  penUp(height: number, rate: number): Promise<void>
  penDown(height: number, rate: number): Promise<void>
  home(): Promise<void>
  disconnect(): Promise<void>
}
