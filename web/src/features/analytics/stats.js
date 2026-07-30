/* LinkedIn Analyzer - Analytics numeric helpers */

/**
 * Compute the Pearson correlation coefficient of two equal-length series.
 * @param {number[]} xs - First series
 * @param {number[]} ys - Second series
 * @returns {number|null} Correlation in [-1, 1], or null when undefined
 */
export function pearson(xs, ys) {
    const n = xs.length;
    /* v8 ignore next 3 */
    if (n < 2) {
        return null;
    }
    let sumX = 0;
    let sumY = 0;
    let sumXX = 0;
    let sumYY = 0;
    let sumXY = 0;
    for (let i = 0; i < n; i++) {
        const x = xs[i];
        const y = ys[i];
        sumX += x;
        sumY += y;
        sumXX += x * x;
        sumYY += y * y;
        sumXY += x * y;
    }
    const covariance = n * sumXY - sumX * sumY;
    const varianceX = n * sumXX - sumX * sumX;
    const varianceY = n * sumYY - sumY * sumY;
    const denominator = Math.sqrt(varianceX * varianceY);
    if (denominator === 0) {
        return null;
    }
    return covariance / denominator;
}

/**
 * Average a numeric array, treating an empty array as 0.
 * @param {number[]} values - Numbers to average
 * @returns {number} Arithmetic mean
 */
export function average(values) {
    if (!values.length) {
        /* v8 ignore next */
        return 0;
    }
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}
