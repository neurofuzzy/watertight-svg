/**
 * Spatial Hash Grid for fast 2D spatial queries.
 * Maps 2D coordinates to a grid of cells, solving N^2 performance bottlenecks.
 */
export class SpatialHash<T> {
    private cellSize: number;
    private grid: Map<string, T[]>;

    constructor(cellSize: number) {
        this.cellSize = cellSize;
        this.grid = new Map();
    }

    /**
     * Get the string key for a grid cell
     */
    private getKey(x: number, y: number): string {
        const cx = Math.floor(x / this.cellSize);
        const cy = Math.floor(y / this.cellSize);
        return `${cx},${cy}`;
    }

    /**
     * Add an item to the spatial hash at a specific point
     */
    public insert(x: number, y: number, item: T) {
        const key = this.getKey(x, y);
        if (!this.grid.has(key)) {
            this.grid.set(key, []);
        }
        this.grid.get(key)!.push(item);
    }

    /**
     * Query items in the same cell as the given point
     */
    public query(x: number, y: number): T[] {
        const key = this.getKey(x, y);
        return this.grid.get(key) || [];
    }

    /**
     * Query items in cells overlapping the given AABB (Axis-Aligned Bounding Box)
     */
    public queryRegion(minX: number, minY: number, maxX: number, maxY: number): T[] {
        const items: Set<T> = new Set();

        const startX = Math.floor(minX / this.cellSize);
        const startY = Math.floor(minY / this.cellSize);
        const endX = Math.floor(maxX / this.cellSize);
        const endY = Math.floor(maxY / this.cellSize);

        for (let x = startX; x <= endX; x++) {
            for (let y = startY; y <= endY; y++) {
                const key = `${x},${y}`;
                const cellItems = this.grid.get(key);
                if (cellItems) {
                    for (const item of cellItems) {
                        items.add(item);
                    }
                }
            }
        }

        return Array.from(items);
    }

    /**
     * Clear all items
     */
    public clear() {
        this.grid.clear();
    }
}
