export const formatPrice = (value: number): string => `${value.toFixed(2)} ₾`;

export const pluralize = (n: number, one: string, many: string): string =>
  n === 1 ? one : many;
