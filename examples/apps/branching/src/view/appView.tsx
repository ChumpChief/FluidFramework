/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import React, { FC, useState } from "react";

import { askHealthBotForSuggestions } from "../healthBot.js";
import { IGroceryList, type BranchFunc } from "../modelInterfaces.js";

import { GroceryListView } from "./groceryListView.js";

export interface IAppViewProps {
	groceryList: IGroceryList;
	branch: BranchFunc;
}

export const AppView: FC<IAppViewProps> = ({ groceryList, branch }: IAppViewProps) => {
	const [branchControls, setBranchControls] = useState<ReturnType<BranchFunc> | undefined>(
		undefined,
	);

	let actions;
	if (branchControls === undefined) {
		const onGetSuggestions = () => {
			setBranchControls(branch());
			askHealthBotForSuggestions(groceryList).catch(console.error);
		};
		actions = <button onClick={onGetSuggestions}>Get suggestions from HealthBot!</button>;
	} else {
		const onAcceptChanges = () => {
			branchControls.merge();
			setBranchControls(undefined);
		};
		const onRejectChanges = () => {
			branchControls.dispose();
			setBranchControls(undefined);
		};
		actions = (
			<>
				<button onClick={onAcceptChanges}>Accept these changes</button>
				<button onClick={onRejectChanges}>Reject these changes</button>
			</>
		);
	}

	return (
		<>
			<h1>Groceries!</h1>
			<GroceryListView groceryList={groceryList} />
			{actions}
		</>
	);
};
