# Konveyor · Asistente de creación de custom targets

Wizard paso a paso (HTML + TypeScript, sin dependencias) para crear
**custom migration targets** de [Konveyor](https://github.com/konveyor),
replicando el flujo de *Administration → Custom migration targets* de
[tackle2-ui](https://github.com/konveyor/tackle2-ui).

## Pasos del wizard

1. **Datos generales** — nombre, descripción, proveedor de lenguaje e icono.
2. **Reglas personalizadas** — tres modos (la subida de ficheros es opcional):
   - **Crear reglas (editor interactivo, modo por defecto)**: formulario asistido
     que genera el YAML del
     [analyzer-lsp](https://github.com/konveyor/analyzer-lsp) sin escribirlo a
     mano: `ruleID` autogenerado, descripción, categoría
     (mandatory/optional/potential), esfuerzo, mensaje para el desarrollador,
     enlace de documentación y condiciones `when` combinables con AND/OR:
     - `java.referenced` (patrón + location: IMPORT, ANNOTATION, METHOD_CALL…)
     - `builtin.filecontent` (regex + filtro de ficheros)
     - `builtin.file` (patrón de nombre de fichero)
     - `builtin.xml` (XPath + filepaths)

     Incluye lista de reglas con edición/borrado, validación por regla
     (ruleID único, condiciones completas, mensaje) y vista previa en vivo del
     YAML generado, descargable como `<slug>-reglas.yaml`.
   - **Subir ficheros**: drag & drop de ficheros YAML de reglas, con análisis
     ligero (cuenta `ruleID`, avisa si falta `when:`, detecta ficheros vacíos
     o `ruleset.yaml` de metadatos).
   - **Repositorio**: git/subversion con URL, branch, path raíz y credencial
     (identity) opcional.
3. **Labels y sources** — genera automáticamente el label
   `konveyor.io/target=<slug>`, permite añadir labels custom y marcar los
   sources compatibles (`konveyor.io/source=…`).
4. **Revisión y creación** — resumen, payload JSON del recurso `Target` de
   tackle2-hub (`POST /hub/targets`), con botones de copiar y descargar
   `target.json`, y las llamadas `curl` necesarias contra un Hub real.

## Uso

Abrir `index.html` directamente en el navegador — el JS compilado
(`wizard.js`) está incluido en el repo.

## Desarrollo

El código fuente está en `wizard.ts` (TypeScript estricto, sin frameworks).
Para recompilar:

```bash
npx tsc -p tsconfig.json   # genera wizard.js
```

## Nota sobre el payload

En un Hub real, cada fichero de reglas se sube primero con
`POST /hub/files` y se referencia por `id` dentro de `ruleset.rules[].file`;
el wizard deja `id: 0` como placeholder. La imagen del target funciona igual
(`image.id`).
