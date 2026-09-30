// Leitet ./http.js der Treiber auf die Attrappe um (nur für tests/drivers.mjs).
export async function resolve(specifier, context, next) {
    if (specifier === './http.js' && context.parentURL?.includes('/linux/src/'))
        return { url: new URL('./http.js', import.meta.url).href, shortCircuit: true };
    return next(specifier, context);
}
