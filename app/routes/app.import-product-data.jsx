import { useState, useEffect, useRef } from "react";
import { useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import ExcelJS from "exceljs";
import { useAppBridge } from "@shopify/app-bridge-react";
import { Pagination } from "@shopify/polaris";

export const loader = async ({ request }) => {
    const { admin } = await authenticate.admin(request);

    // Fetch all locations including app-managed ones
    const response = await admin.graphql(
        `#graphql
        query getLocations {
            locations(first: 250, includeLegacy: true, includeInactive: true) {
                edges {
                    node {
                        id
                        name
                        isActive
                    }
                }
            }
        }`
    );

    const data = await response.json();
    const locations = data.data?.locations?.edges.map(edge => ({
        id: edge.node.id,
        name: edge.node.name,
        isActive: edge.node.isActive
    })) || [];

    return { locations };
};

export const action = async ({ request }) => {
    const { admin } = await authenticate.admin(request);

    const formData = await request.formData();
    const dataString = formData.get("data");
    const locationId = formData.get("locationId");
    const rows = JSON.parse(dataString);

    const results = {
        total: rows.length,
        updated: 0,
        errors: [],
        failedRows: [],
        skippedRows: []
    };

    // Check if "All Locations" mode is selected
    const isAllLocationsMode = locationId === "ALL_LOCATIONS";

    // Fetch all locations if in All Locations mode
    let allLocations = [];
    if (isAllLocationsMode) {
        const locationsQuery = await admin.graphql(
            `#graphql
            query getLocations {
                locations(first: 250, includeLegacy: true, includeInactive: true) {
                    edges {
                        node {
                            id
                            name
                        }
                    }
                }
            }`
        );
        const locationsResult = await locationsQuery.json();
        allLocations = locationsResult.data?.locations?.edges.map(edge => ({
            id: edge.node.id,
            name: edge.node.name
        })) || [];
    }

    // Fetch selected location name once (for single location mode)
    let selectedLocationName = null;
    if (!isAllLocationsMode) {
        const locationQuery = await admin.graphql(
            `#graphql
            query getLocation($id: ID!) {
                location(id: $id) {
                    name
                }
            }`,
            { variables: { id: locationId } }
        );
        const locationResult = await locationQuery.json();
        selectedLocationName = locationResult.data?.location?.name;
    }

    // Track processed SKU+Location combinations to detect duplicates
    const processedCombinations = new Set();

    // Process each row
    for (const row of rows) {
        try {
            // Skip header or empty rows
            if (!row["SKU"] || row["SKU"] === "SKU") {
                continue;
            }

            const sku = row["SKU"];
            const quantityRaw = row["Quantity Available"];

            // Validate quantity - must be a valid number
            const quantity = parseInt(quantityRaw);
            if (isNaN(quantity) || quantity === null || quantity === undefined) {
                results.errors.push(`Skipped SKU ${sku}: Invalid or missing quantity value`);
                results.failedRows.push({ ...row, "Error Reason": 'Invalid or missing quantity value' });
                continue;
            }

            const sheetLocationRaw = row["Inventory Location"];
            const sheetLocation = sheetLocationRaw ? String(sheetLocationRaw).trim() : "";

            // Mandatory Location Check
            if (!sheetLocation) {
                results.errors.push(`Skipped SKU ${sku}: please add proper location`);
                results.failedRows.push({ ...row, "Error Reason": 'please add proper location' });
                continue;
            }

            // Determine which location to use
            let targetLocationId = locationId;
            let targetLocationName = selectedLocationName;

            if (isAllLocationsMode) {
                // Find the location in our store (case-insensitive)
                const foundLocation = allLocations.find(loc => loc.name.toLowerCase() === sheetLocation.toLowerCase());
                if (!foundLocation) {
                    results.errors.push(`Skipped SKU ${sku}: Location '${sheetLocation}' not found in store`);
                    results.failedRows.push({ ...row, "Error Reason": `Location '${sheetLocation}' not found in store` });
                    continue;
                }

                targetLocationId = foundLocation.id;
                targetLocationName = foundLocation.name;
            } else {
                // Single location mode - validate if location matches (case-insensitive)
                if (sheetLocation.toLowerCase() !== selectedLocationName.toLowerCase()) {
                    results.errors.push(`Skipped SKU ${sku}: Location in sheet '${sheetLocation}' does not match selected location '${selectedLocationName}'`);
                    results.failedRows.push({ ...row, "Error Reason": `Location mismatch: '${sheetLocation}' ≠ '${selectedLocationName}'` });
                    continue;
                }
            }

            // Check for duplicate SKU+Location combination
            const combinationKey = `${sku}|${targetLocationName}`;
            if (processedCombinations.has(combinationKey)) {
                results.errors.push(`Skipped SKU ${sku}: You have identical row having same SKU and location`);
                results.failedRows.push({ ...row, "Error Reason": 'You have identical row having same SKU and location' });
                continue;
            }
            processedCombinations.add(combinationKey);

            // Find variant by SKU
            const variantQuery = await admin.graphql(
                `#graphql
                query findVariantBySKU($query: String!) {
                    productVariants(first: 1, query: $query) {
                        edges {
                            node {
                                id
                                sku
                                inventoryItem {
                                    id
                                    inventoryLevels(first: 50) {
                                        edges {
                                            node {
                                                location {
                                                    id
                                                }
                                                quantities(names: ["available"]) {
                                                    quantity
                                                    name
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }`,
                {
                    variables: {
                        query: `sku:${sku}`
                    }
                }
            );

            const variantResult = await variantQuery.json();
            const variant = variantResult.data?.productVariants?.edges[0]?.node;

            if (!variant) {
                results.errors.push(`Variant not found for SKU: ${sku}`);
                results.failedRows.push({ ...row, "Error Reason": 'Variant not found' });
                continue;
            }

            // Find current quantity at the target location
            let currentQuantity = 0;
            let locationFound = false;
            const inventoryLevels = variant.inventoryItem.inventoryLevels?.edges || [];
            for (const level of inventoryLevels) {
                if (level.node.location.id === targetLocationId) {
                    const availableQty = level.node.quantities.find(q => q.name === "available");
                    currentQuantity = availableQty?.quantity || 0;
                    locationFound = true;
                    break;
                }
            }

            // Validate that the location exists for this SKU
            if (!locationFound) {
                results.errors.push(`Skipped SKU ${sku}: SKU don't have this location`);
                results.failedRows.push({ ...row, "Error Reason": `SKU don't have this location` });
                continue;
            }

            // Skip if quantity is already the same
            if (currentQuantity === quantity) {
                results.skippedRows.push({ ...row, "Reason": 'Quantity already matches' });
                continue;
            }

            // Update inventory quantity at the selected location
            const updateMutation = await admin.graphql(
                `#graphql
                mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) {
                    inventorySetQuantities(input: $input) {
                        inventoryAdjustmentGroup {
                            id
                        }
                        userErrors {
                            field
                            message
                        }
                    }
                }`,
                {
                    variables: {
                        input: {
                            reason: "correction",
                            name: "available",
                            ignoreCompareQuantity: true,
                            quantities: [
                                {
                                    inventoryItemId: variant.inventoryItem.id,
                                    locationId: targetLocationId,
                                    quantity: quantity
                                }
                            ]
                        }
                    }
                }
            );

            const updateResult = await updateMutation.json();

            if (updateResult.data?.inventorySetQuantities?.userErrors?.length > 0) {
                const errorMsg = updateResult.data.inventorySetQuantities.userErrors[0].message;
                results.errors.push(`Error updating SKU ${sku}: ${errorMsg}`);
                results.failedRows.push({ ...row, "Error Reason": errorMsg });
            } else {
                results.updated++;
            }

        } catch (error) {
            results.errors.push(`Error processing SKU ${row["SKU"]}: ${error.message}`);
            results.failedRows.push({ ...row, "Error Reason": error.message });
        }
    }

    return { success: true, results };
};

export default function ImportProductData() {
    const shopify = useAppBridge();
    const fetcher = useFetcher();
    const loaderFetcher = useFetcher();
    const [file, setFile] = useState(null);
    const [parsedData, setParsedData] = useState(null);
    const [selectedLocation, setSelectedLocation] = useState("");
    const fileInputRef = useRef(null);

    // Pagination state for Failed Rows
    const [failedPage, setFailedPage] = useState(1);
    const failedRowsPerPage = 10;

    // Pagination state for Skipped Rows
    const [skippedPage, setSkippedPage] = useState(1);
    const skippedRowsPerPage = 10;

    const isLoading = fetcher.state === "submitting" || fetcher.state === "loading";
    const locations = loaderFetcher.data?.locations || [];

    useEffect(() => {
        // Load locations on mount
        loaderFetcher.load("/app/import-product-data");
    }, []);

    const handleFileChange = (e) => {
        const selectedFile = e.target.files[0];
        if (selectedFile) {
            setFile(selectedFile);
            setFailedPage(1);
            setSkippedPage(1);

            // Parse the Excel file using ExcelJS
            const reader = new FileReader();
            reader.onload = async (event) => {
                const buffer = event.target.result;
                const workbook = new ExcelJS.Workbook();
                await workbook.xlsx.load(buffer);

                const worksheet = workbook.worksheets[0];
                const jsonData = [];

                // Get headers from first row
                const headers = [];
                worksheet.getRow(1).eachCell((cell, colNumber) => {
                    headers[colNumber] = cell.value;
                });

                // Convert rows to JSON objects
                worksheet.eachRow((row, rowNumber) => {
                    if (rowNumber > 1) { // Skip header row
                        const rowData = {};
                        row.eachCell((cell, colNumber) => {
                            if (headers[colNumber]) {
                                rowData[headers[colNumber]] = cell.value;
                            }
                        });
                        jsonData.push(rowData);
                    }
                });

                setParsedData(jsonData);

                // Check if location is selected
                if (!selectedLocation) {
                    shopify.toast.show("Please select a location first");
                    return;
                }

                // Auto-import after parsing
                shopify.toast.show(`File loaded: ${jsonData.length} rows. Starting import...`);
                fetcher.submit(
                    {
                        data: JSON.stringify(jsonData),
                        locationId: selectedLocation
                    },
                    { method: "POST" }
                );
            };
            reader.readAsArrayBuffer(selectedFile);
        }
    };

    const handleButtonClick = () => {
        if (!selectedLocation) {
            shopify.toast.show("Please select a location first");
            return;
        }

        // Trigger the hidden file input
        if (fileInputRef.current) {
            fileInputRef.current.click();
        }
    };

    useEffect(() => {
        if (fetcher.data?.success && fetcher.state === "idle") {
            const { results } = fetcher.data;
            shopify.toast.show(`Import complete: ${results.updated} updated, ${results.errors.length} errors`);

            // Reset file input
            setFile(null);
            setParsedData(null);
            if (fileInputRef.current) {
                fileInputRef.current.value = "";
            }
        }
    }, [fetcher.data, fetcher.state, shopify]);

    return (
        <s-page heading="Import Product Data">
            <s-section heading="Select a location and upload an Excel file with SKU, Quantity Available and Inventory Location columns. Other columns are optional.">
                <s-select
                    label="Choose Location"
                    value={selectedLocation}
                    onChange={(e) => setSelectedLocation(e.target.value)}
                >
                    <s-option value="">Select a location...</s-option>
                    <s-option value="ALL_LOCATIONS">All Locations</s-option>
                    {locations.map((location) => (
                        <s-option key={location.id} value={location.id}>
                            {location.name}
                        </s-option>
                    ))}
                </s-select>

                {/* Hidden file input */}
                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".xlsx,.xls"
                    onChange={handleFileChange}
                    style={{ display: 'none' }}
                />


                <s-button
                    variant="primary"
                    onClick={handleButtonClick}
                    loading={isLoading ? "true" : undefined}
                    disabled={!selectedLocation}
                    paddingBlock="large"
                >
                    Import Products
                </s-button>
            </s-section>

            {!isLoading && fetcher.data?.results && (
                <>
                    <s-section heading="Import Results">
                        <s-stack gap="200" direction="block">
                            <s-text as="p">Total rows: {fetcher.data.results.total}</s-text>
                            <s-text as="p">Successfully updated: {fetcher.data.results.updated}</s-text>
                            <s-text as="p">Skipped: {fetcher.data.results.skippedRows?.length || 0}</s-text>
                            <s-text as="p">Errors: {fetcher.data.results.errors.length}</s-text>
                        </s-stack>
                    </s-section>

                    {fetcher.data.results.failedRows?.length > 0 && (
                        <s-section heading={`❌ Failed Rows (${fetcher.data.results.failedRows.length})`}>
                            <s-table>
                                <s-table-header-row>
                                    {Object.keys(fetcher.data.results.failedRows[0] || {}).map((key) => (
                                        <s-table-header key={key}>{key}</s-table-header>
                                    ))}
                                </s-table-header-row>
                                <s-table-body>
                                    {fetcher.data.results.failedRows
                                        .slice((failedPage - 1) * failedRowsPerPage, failedPage * failedRowsPerPage)
                                        .map((row, index) => (
                                            <s-table-row key={index}>
                                                {Object.keys(fetcher.data.results.failedRows[0] || {}).map((key, cellIndex) => (
                                                    <s-table-cell key={cellIndex}>
                                                        {row[key]?.toString() || '-'}
                                                    </s-table-cell>
                                                ))}
                                            </s-table-row>
                                        ))}
                                </s-table-body>
                            </s-table>
                            {fetcher.data.results.failedRows.length > failedRowsPerPage && (
                                <Pagination
                                    hasPrevious={failedPage > 1}
                                    onPrevious={() => setFailedPage(failedPage - 1)}
                                    hasNext={failedPage < Math.ceil(fetcher.data.results.failedRows.length / failedRowsPerPage)}
                                    onNext={() => setFailedPage(failedPage + 1)}
                                    type="table"
                                    label={`${((failedPage - 1) * failedRowsPerPage) + 1}-${Math.min(failedPage * failedRowsPerPage, fetcher.data.results.failedRows.length)} of ${fetcher.data.results.failedRows.length}`}
                                />
                            )}
                        </s-section>
                    )}

                    {fetcher.data.results.skippedRows?.length > 0 && (
                        <s-section heading={`⏭️ Skipped Rows (${fetcher.data.results.skippedRows.length}) - Quantity Already Matches`}>
                            <s-table>
                                <s-table-header-row>
                                    {Object.keys(fetcher.data.results.skippedRows[0] || {}).map((key) => (
                                        <s-table-header key={key}>{key}</s-table-header>
                                    ))}
                                </s-table-header-row>
                                <s-table-body>
                                    {fetcher.data.results.skippedRows
                                        .slice((skippedPage - 1) * skippedRowsPerPage, skippedPage * skippedRowsPerPage)
                                        .map((row, index) => (
                                            <s-table-row key={index}>
                                                {Object.keys(fetcher.data.results.skippedRows[0] || {}).map((key, cellIndex) => (
                                                    <s-table-cell key={cellIndex}>
                                                        {row[key]?.toString() || '-'}
                                                    </s-table-cell>
                                                ))}
                                            </s-table-row>
                                        ))}
                                </s-table-body>
                            </s-table>
                            {fetcher.data.results.skippedRows.length > skippedRowsPerPage && (
                                <Pagination
                                    hasPrevious={skippedPage > 1}
                                    onPrevious={() => setSkippedPage(skippedPage - 1)}
                                    hasNext={skippedPage < Math.ceil(fetcher.data.results.skippedRows.length / skippedRowsPerPage)}
                                    onNext={() => setSkippedPage(skippedPage + 1)}
                                    type="table"
                                    label={`${((skippedPage - 1) * skippedRowsPerPage) + 1}-${Math.min(skippedPage * skippedRowsPerPage, fetcher.data.results.skippedRows.length)} of ${fetcher.data.results.skippedRows.length}`}
                                />
                            )}
                        </s-section>
                    )}
                </>
            )
            }
        </s-page>
    );
}
