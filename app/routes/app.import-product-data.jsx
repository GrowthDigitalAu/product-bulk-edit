import { useState, useEffect, useRef } from "react";
import { useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import ExcelJS from "exceljs";
import { useAppBridge } from "@shopify/app-bridge-react";

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
                results.failedRows.push({ ...row, errorReason: 'Invalid or missing quantity value' });
                continue;
            }

            const sheetLocation = row["Inventory Location"];

            // Determine which location to use
            let targetLocationId = locationId;
            let targetLocationName = selectedLocationName;

            if (isAllLocationsMode) {
                // In All Locations mode, location MUST be specified in sheet
                if (!sheetLocation || sheetLocation.trim() === "") {
                    results.errors.push(`Skipped SKU ${sku}: No location specified in sheet (required for All Locations mode)`);
                    results.failedRows.push({ ...row, errorReason: 'No location specified in sheet' });
                    continue;
                }

                // Find the location in our store
                const foundLocation = allLocations.find(loc => loc.name === sheetLocation.trim());
                if (!foundLocation) {
                    results.errors.push(`Skipped SKU ${sku}: Location '${sheetLocation}' not found in store`);
                    results.failedRows.push({ ...row, errorReason: `Location '${sheetLocation}' not found in store` });
                    continue;
                }

                targetLocationId = foundLocation.id;
                targetLocationName = foundLocation.name;
            } else {
                // Single location mode - validate if location is specified in sheet
                if (sheetLocation && sheetLocation.trim() !== "" && sheetLocation.trim() !== selectedLocationName) {
                    results.errors.push(`Skipped SKU ${sku}: Location in sheet '${sheetLocation}' does not match selected location '${selectedLocationName}'`);
                    results.failedRows.push({ ...row, errorReason: `Location mismatch: '${sheetLocation}' ≠ '${selectedLocationName}'` });
                    continue;
                }
            }

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
                                    inventoryLevels(first: 10) {
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
                results.failedRows.push({ ...row, errorReason: 'Variant not found' });
                continue;
            }

            // Find current quantity at the target location
            let currentQuantity = 0;
            const inventoryLevels = variant.inventoryItem.inventoryLevels?.edges || [];
            for (const level of inventoryLevels) {
                if (level.node.location.id === targetLocationId) {
                    const availableQty = level.node.quantities.find(q => q.name === "available");
                    currentQuantity = availableQty?.quantity || 0;
                    break;
                }
            }

            // Skip if quantity is already the same
            if (currentQuantity === quantity) {
                results.skippedRows.push({ ...row, reason: 'Quantity already matches' });
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
                results.failedRows.push({ ...row, errorReason: errorMsg });
            } else {
                results.updated++;
            }

        } catch (error) {
            results.errors.push(`Error processing SKU ${row["SKU"]}: ${error.message}`);
            results.failedRows.push({ ...row, errorReason: error.message });
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
            <s-layout>
                <s-layout-section>
                    <s-card>
                        <s-block-stack gap="400">
                            <s-text as="p" variant="bodyMd">
                                Select a location and upload an Excel file with SKU and Quantity Available columns.
                            </s-text>

                            <s-block-stack gap="200">
                                <s-text as="label" variant="bodyMd" fontWeight="semibold">
                                    Inventory Location (Required)
                                </s-text>
                                <select
                                    value={selectedLocation}
                                    onChange={(e) => setSelectedLocation(e.target.value)}
                                    style={{
                                        padding: "8px 12px",
                                        border: "1px solid #c9cccf",
                                        borderRadius: "4px",
                                        fontSize: "14px",
                                        backgroundColor: "white",
                                        cursor: "pointer"
                                    }}
                                >
                                    <option value="">Select a location...</option>
                                    <option value="ALL_LOCATIONS">All Locations</option>
                                    {locations.map((location) => (
                                        <option key={location.id} value={location.id}>
                                            {location.name}
                                        </option>
                                    ))}
                                </select>
                            </s-block-stack>

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
                            >
                                Import Products
                            </s-button>

                            {fetcher.data?.results && (
                                <s-card>
                                    <s-block-stack gap="300">
                                        <s-text as="h3" variant="headingSm">Import Results</s-text>
                                        <s-text as="p">Total rows: {fetcher.data.results.total}</s-text>
                                        <s-text as="p">Successfully updated: {fetcher.data.results.updated}</s-text>
                                        <s-text as="p">Skipped: {fetcher.data.results.skippedRows?.length || 0}</s-text>
                                        <s-text as="p">Errors: {fetcher.data.results.errors.length}</s-text>

                                        {fetcher.data.results.failedRows?.length > 0 && (
                                            <s-block-stack gap="200">
                                                <s-text as="p" variant="bodyMd" fontWeight="semibold" tone="critical">
                                                    ❌ Failed Rows ({fetcher.data.results.failedRows.length}):
                                                </s-text>
                                                <div style={{ overflowX: 'auto' }}>
                                                    <table style={{
                                                        width: '100%',
                                                        borderCollapse: 'collapse',
                                                        fontSize: '13px'
                                                    }}>
                                                        <thead>
                                                            <tr style={{ backgroundColor: '#f6f6f7', borderBottom: '1px solid #e1e3e5' }}>
                                                                {Object.keys(fetcher.data.results.failedRows[0] || {}).map((key) => (
                                                                    <th key={key} style={{
                                                                        padding: '12px 16px',
                                                                        textAlign: 'left',
                                                                        fontWeight: '600',
                                                                        color: '#202223'
                                                                    }}>
                                                                        {key}
                                                                    </th>
                                                                ))}
                                                            </tr>
                                                        </thead>
                                                        <tbody>
                                                            {fetcher.data.results.failedRows.map((row, index) => (
                                                                <tr key={index} style={{ borderBottom: '1px solid #e1e3e5' }}>
                                                                    {Object.entries(row).map(([key, value], cellIndex) => (
                                                                        <td key={cellIndex} style={{
                                                                            padding: '12px 16px',
                                                                            color: key === 'errorReason' ? '#d72c0d' : '#202223'
                                                                        }}>
                                                                            {value?.toString() || '-'}
                                                                        </td>
                                                                    ))}
                                                                </tr>
                                                            ))}
                                                        </tbody>
                                                    </table>
                                                </div>
                                            </s-block-stack>
                                        )}

                                        {fetcher.data.results.skippedRows?.length > 0 && (
                                            <s-block-stack gap="200">
                                                <s-text as="p" variant="bodyMd" fontWeight="semibold" tone="info">
                                                    ⏭️ Skipped Rows ({fetcher.data.results.skippedRows.length}) - Quantity Already Matches:
                                                </s-text>
                                                <div style={{ overflowX: 'auto' }}>
                                                    <table style={{
                                                        width: '100%',
                                                        borderCollapse: 'collapse',
                                                        fontSize: '13px'
                                                    }}>
                                                        <thead>
                                                            <tr style={{ backgroundColor: '#f6f6f7', borderBottom: '1px solid #e1e3e5' }}>
                                                                {Object.keys(fetcher.data.results.skippedRows[0] || {}).map((key) => (
                                                                    <th key={key} style={{
                                                                        padding: '12px 16px',
                                                                        textAlign: 'left',
                                                                        fontWeight: '600',
                                                                        color: '#202223'
                                                                    }}>
                                                                        {key}
                                                                    </th>
                                                                ))}
                                                            </tr>
                                                        </thead>
                                                        <tbody>
                                                            {fetcher.data.results.skippedRows.map((row, index) => (
                                                                <tr key={index} style={{ borderBottom: '1px solid #e1e3e5' }}>
                                                                    {Object.entries(row).map(([key, value], cellIndex) => (
                                                                        <td key={cellIndex} style={{
                                                                            padding: '12px 16px',
                                                                            color: key === 'reason' ? '#0a7ea4' : '#202223'
                                                                        }}>
                                                                            {value?.toString() || '-'}
                                                                        </td>
                                                                    ))}
                                                                </tr>
                                                            ))}
                                                        </tbody>
                                                    </table>
                                                </div>
                                            </s-block-stack>
                                        )}
                                    </s-block-stack>
                                </s-card>
                            )}
                        </s-block-stack>
                    </s-card>
                </s-layout-section>
            </s-layout>
        </s-page>
    );
}
