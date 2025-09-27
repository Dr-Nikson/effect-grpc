module.exports = {
  experimentalTernaries: true,
  printWidth: 100,
  tabWidth: 2,
  parser: "typescript",
  plugins: ["@trivago/prettier-plugin-sort-imports"],
  importOrder: ["^@(.*)$", "^@whisklabs(.*)$", "^[./]"],
  importOrderSeparation: true,
  importOrderSortSpecifiers: true,
  importOrderGroupNamespaceSpecifiers: true
}
