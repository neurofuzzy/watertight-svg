/**
 * Simple SVG Parser for Tests
 * 
 * A lightweight parser that extracts paths from SVG without browser DOM.
 * Supports: line, polyline, polygon, rect, circle (simplified)
 * Does NOT support: bezier curves, arcs, text
 */

import type { Point, Path, SVGDocument } from '../geometry/types';

/**
 * Parse SVG string into paths (no DOM required)
 */
export function parseSimpleSVG(svgString: string): SVGDocument {
    const paths: Path[] = [];

    // Extract viewBox
    const viewBoxMatch = svgString.match(/viewBox="([^"]+)"/);
    const viewBox = viewBoxMatch?.[1];

    // Parse dimensions
    const widthMatch = svgString.match(/width="([^"]+)"/);
    const heightMatch = svgString.match(/height="([^"]+)"/);
    const width = parseFloat(widthMatch?.[1] || '100');
    const height = parseFloat(heightMatch?.[1] || '100');

    // Extract <line> elements
    const lineRegex = /<line[^>]*x1="([^"]+)"[^>]*y1="([^"]+)"[^>]*x2="([^"]+)"[^>]*y2="([^"]+)"[^>]*\/?>/gi;
    let match;
    while ((match = lineRegex.exec(svgString)) !== null) {
        const x1 = parseFloat(match[1]);
        const y1 = parseFloat(match[2]);
        const x2 = parseFloat(match[3]);
        const y2 = parseFloat(match[4]);
        paths.push({
            points: [{ x: x1, y: y1 }, { x: x2, y: y2 }],
            closed: false,
        });
    }

    // Extract <polyline> elements
    const polylineRegex = /<polyline[^>]*points="([^"]+)"[^>]*\/?>/gi;
    while ((match = polylineRegex.exec(svgString)) !== null) {
        const points = parsePoints(match[1]);
        if (points.length >= 2) {
            paths.push({ points, closed: false });
        }
    }

    // Extract <polygon> elements
    const polygonRegex = /<polygon[^>]*points="([^"]+)"[^>]*\/?>/gi;
    while ((match = polygonRegex.exec(svgString)) !== null) {
        const points = parsePoints(match[1]);
        if (points.length >= 3) {
            paths.push({ points, closed: true });
        }
    }

    // Extract <path> elements (basic M/L/Z commands only)
    const pathRegex = /<path[^>]*d="([^"]+)"[^>]*\/?>/gi;
    while ((match = pathRegex.exec(svgString)) !== null) {
        const pathData = match[1];
        const parsed = parsePathData(pathData);
        paths.push(...parsed);
    }

    // Extract <rect> elements
    const rectRegex = /<rect[^>]*x="([^"]*)"[^>]*y="([^"]*)"[^>]*width="([^"]+)"[^>]*height="([^"]+)"[^>]*\/?>/gi;
    while ((match = rectRegex.exec(svgString)) !== null) {
        const x = parseFloat(match[1] || '0');
        const y = parseFloat(match[2] || '0');
        const w = parseFloat(match[3]);
        const h = parseFloat(match[4]);
        paths.push({
            points: [
                { x, y },
                { x: x + w, y },
                { x: x + w, y: y + h },
                { x, y: y + h },
            ],
            closed: true,
        });
    }

    return { width, height, paths, viewBox };
}

/**
 * Parse SVG points attribute (e.g. "10,20 30,40 50,60")
 */
function parsePoints(pointsStr: string): Point[] {
    const points: Point[] = [];
    const pairs = pointsStr.trim().split(/\s+/);

    for (const pair of pairs) {
        const [x, y] = pair.split(',').map(parseFloat);
        if (!isNaN(x) && !isNaN(y)) {
            points.push({ x, y });
        }
    }

    return points;
}

/**
 * Parse basic SVG path data (M, L, H, V, Z commands)
 */
function parsePathData(d: string): Path[] {
    const paths: Path[] = [];
    let currentPath: Point[] = [];
    let currentX = 0;
    let currentY = 0;
    let startX = 0;
    let startY = 0;

    // Tokenize path data
    const tokens = d.match(/[MLHVZCSQTAmlhvzcsqta]|[-+]?[0-9]*\.?[0-9]+/g) || [];
    let i = 0;

    while (i < tokens.length) {
        const cmd = tokens[i];

        switch (cmd) {
            case 'M': // Move to (absolute)
                if (currentPath.length >= 2) {
                    paths.push({ points: currentPath, closed: false });
                }
                currentX = parseFloat(tokens[++i]);
                currentY = parseFloat(tokens[++i]);
                startX = currentX;
                startY = currentY;
                currentPath = [{ x: currentX, y: currentY }];
                break;

            case 'm': // Move to (relative)
                if (currentPath.length >= 2) {
                    paths.push({ points: currentPath, closed: false });
                }
                currentX += parseFloat(tokens[++i]);
                currentY += parseFloat(tokens[++i]);
                startX = currentX;
                startY = currentY;
                currentPath = [{ x: currentX, y: currentY }];
                break;

            case 'L': // Line to (absolute)
                currentX = parseFloat(tokens[++i]);
                currentY = parseFloat(tokens[++i]);
                currentPath.push({ x: currentX, y: currentY });
                break;

            case 'l': // Line to (relative)
                currentX += parseFloat(tokens[++i]);
                currentY += parseFloat(tokens[++i]);
                currentPath.push({ x: currentX, y: currentY });
                break;

            case 'H': // Horizontal line (absolute)
                currentX = parseFloat(tokens[++i]);
                currentPath.push({ x: currentX, y: currentY });
                break;

            case 'h': // Horizontal line (relative)
                currentX += parseFloat(tokens[++i]);
                currentPath.push({ x: currentX, y: currentY });
                break;

            case 'V': // Vertical line (absolute)
                currentY = parseFloat(tokens[++i]);
                currentPath.push({ x: currentX, y: currentY });
                break;

            case 'v': // Vertical line (relative)
                currentY += parseFloat(tokens[++i]);
                currentPath.push({ x: currentX, y: currentY });
                break;

            case 'Z':
            case 'z': // Close path
                currentX = startX;
                currentY = startY;
                if (currentPath.length >= 2) {
                    paths.push({ points: currentPath, closed: true });
                }
                currentPath = [];
                break;

            default:
                // Skip unsupported commands (C, S, Q, T, A, etc.)
                // Just consume their parameters
                i++;
        }
        i++;
    }

    // Push final path if not closed
    if (currentPath.length >= 2) {
        paths.push({ points: currentPath, closed: false });
    }

    return paths;
}
